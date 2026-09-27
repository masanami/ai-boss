//! 資格情報を付与するストリーミング転送（中止つき）。
//!
//! - 宛先は名前で指定し、[`DestinationTable`] に無い名前は送らない
//! - `x-api-key` と `anthropic-version` はこの層が付与し、呼び出し元が渡した同名のヘッダと
//!   `authorization` は捨てる
//! - リダイレクトに追従しない（3xx は「リダイレクト拒否」の失敗にする）
//! - 応答の本文はバイト列の断片のまま順に中継する（SSE の区切りは解釈しない）

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::redirect;
use secrecy::ExposeSecret;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::destination::{Credential, DestinationTable, ANTHROPIC_VERSION};
use crate::key_store::{KeyStore, Seal, StoreError};

/// 呼び出し元が渡しても捨てるヘッダ（資格情報と、送信の枠組みをこの層が決めるもの）。
const DROPPED_REQUEST_HEADERS: [&str; 7] = [
    "x-api-key",
    "authorization",
    "anthropic-version",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
];

/// 応答の頭へ写すヘッダ。
const ALLOWED_RESPONSE_HEADERS: [&str; 3] = ["retry-after", "request-id", "content-type"];

/// 送信の要求。
#[derive(Clone)]
pub struct SendRequest {
    /// 呼び出し元が要求ごとに生成する一意な値。中止はこの値で要求を指す。
    pub request_id: String,
    /// 宛先の名前（例: `anthropic-messages`）。
    pub destination: String,
    /// 呼び出し元が付けたい秘密でないヘッダ（例: `anthropic-beta`）。
    pub headers: Vec<(String, String)>,
    /// 要求本文（JSON）。
    pub body: String,
}

/// 要求本文は `Debug` に出さない。
impl fmt::Debug for SendRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SendRequest")
            .field("request_id", &self.request_id)
            .field("destination", &self.destination)
            .field("headers", &self.headers.iter().map(|(name, _)| name).collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// 応答の頭（ステータスと許可したヘッダだけ）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub retry_after: Option<String>,
    pub request_id: Option<String>,
    pub content_type: Option<String>,
}

/// 送信の失敗。キー・要求本文・応答本文を持たない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// 宛先の表に無い名前。
    UnknownDestination,
    /// 宛先が必要とするキーが登録されていない。
    KeyNotRegistered,
    /// 保管のポートの失敗。
    KeyStore(StoreError),
    /// 呼び出し元のヘッダの名前または値が HTTP のヘッダとして不正。
    InvalidHeader,
    /// 同じ `request_id` の要求が送信中。
    DuplicateRequestId,
    /// 接続・送受信の失敗。
    Connection,
    /// 中止された。
    Cancelled,
    /// 送信先が 3xx で誘導した（誘導先へは送らない。誘導先の URL は持たない）。
    RedirectRefused { status: u16 },
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TransportError::UnknownDestination => write!(f, "unknown destination"),
            TransportError::KeyNotRegistered => write!(f, "key is not registered"),
            TransportError::KeyStore(error) => write!(f, "key store error: {error}"),
            TransportError::InvalidHeader => write!(f, "invalid request header"),
            TransportError::DuplicateRequestId => write!(f, "request id is already in flight"),
            TransportError::Connection => write!(f, "connection failed"),
            TransportError::Cancelled => write!(f, "cancelled"),
            TransportError::RedirectRefused { status } => write!(f, "redirect refused (HTTP {status})"),
        }
    }
}

impl std::error::Error for TransportError {}

type InFlight = Arc<Mutex<HashMap<String, CancellationToken>>>;

/// 資格情報を付与して決められた宛先へ送る通信層。
pub struct SecureTransport {
    client: reqwest::Client,
    destinations: DestinationTable,
    store: Arc<dyn KeyStore>,
    in_flight: InFlight,
}

impl SecureTransport {
    pub fn new(destinations: DestinationTable, store: Arc<dyn KeyStore>) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .build()
            .map_err(|_| TransportError::Connection)?;
        Ok(Self { client, destinations, store, in_flight: Arc::default() })
    }

    /// 要求を送り、応答の頭を受け取った時点で返す。本文は [`ResponseStream::next_chunk`] で順に受け取る。
    ///
    /// `request_id` は最初に登録するため、その後（宛先の解決・キーの読み出しの間を含む）の
    /// [`cancel`](Self::cancel) は送信を止める。登録より前（この future を最初に poll する前）の中止は届かない。
    pub async fn send(&self, request: SendRequest) -> Result<ResponseStream, TransportError> {
        let guard = InFlightGuard::register(&self.in_flight, request.request_id)?;
        let destination = self.destinations.get(&request.destination).ok_or(TransportError::UnknownDestination)?;
        let headers = self.request_headers(destination.credential(), &request.headers)?;

        let sending = self.client.post(destination.url()).headers(headers).body(request.body).send();
        let response = tokio::select! {
            biased;
            () = guard.token.cancelled() => return Err(TransportError::Cancelled),
            response = sending => response.map_err(|_| TransportError::Connection)?,
        };

        let status = response.status();
        if status.is_redirection() {
            return Err(TransportError::RedirectRefused { status: status.as_u16() });
        }
        let head = response_head(status.as_u16(), response.headers());
        Ok(ResponseStream { head, response: Some(response), guard: Some(guard) })
    }

    /// 送信中の要求を中止する。該当する要求が送信中なら真。
    pub fn cancel(&self, request_id: &str) -> bool {
        match lock(&self.in_flight).get(request_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// 資格情報を先に付け、呼び出し元のヘッダは捨てる対象を除いて追記する。
    fn request_headers(&self, credential: Credential, caller: &[(String, String)]) -> Result<HeaderMap, TransportError> {
        let mut headers = HeaderMap::new();
        match credential {
            Credential::AnthropicApiKey => {
                let key = self
                    .store
                    .load(credential.provider(), Seal::new())
                    .map_err(TransportError::KeyStore)?
                    .ok_or(TransportError::KeyNotRegistered)?;
                let mut api_key =
                    HeaderValue::from_str(key.expose_secret())
                    .map_err(|_| TransportError::KeyStore(StoreError::InvalidKeyFormat))?;
                api_key.set_sensitive(true);
                headers.insert(HeaderName::from_static("x-api-key"), api_key);
                headers.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(ANTHROPIC_VERSION));
            }
            Credential::OpenAiBearer => {
                let key = self
                    .store
                    .load(credential.provider(), Seal::new())
                    .map_err(TransportError::KeyStore)?
                    .ok_or(TransportError::KeyNotRegistered)?;
                // 組み立てた `Bearer <キー>` の文字列も、drop 時に消去する（keychain.rs の
                // 読み出しと同じ `Zeroizing` の規律）。
                let bearer_value = Zeroizing::new(format!("Bearer {}", key.expose_secret()));
                let mut authorization = HeaderValue::from_str(&bearer_value)
                    .map_err(|_| TransportError::KeyStore(StoreError::InvalidKeyFormat))?;
                authorization.set_sensitive(true);
                headers.insert(HeaderName::from_static("authorization"), authorization);
            }
        }

        for (name, value) in caller {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| TransportError::InvalidHeader)?;
            if DROPPED_REQUEST_HEADERS.contains(&name.as_str()) {
                continue;
            }
            let value = HeaderValue::from_str(value).map_err(|_| TransportError::InvalidHeader)?;
            headers.append(name, value);
        }
        if !headers.contains_key(CONTENT_TYPE) {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        Ok(headers)
    }
}

/// 送信中の応答。本文の断片を順に返す。
pub struct ResponseStream {
    head: ResponseHead,
    response: Option<reqwest::Response>,
    guard: Option<InFlightGuard>,
}

impl ResponseStream {
    pub fn head(&self) -> &ResponseHead {
        &self.head
    }

    /// 次の断片。終端で `None`。中止・受信の失敗は `Some(Err(..))` を 1 度返してから終端になる。
    pub async fn next_chunk(&mut self) -> Option<Result<Bytes, TransportError>> {
        let (response, guard) = (self.response.as_mut()?, self.guard.as_ref()?);
        let result = tokio::select! {
            biased;
            () = guard.token.cancelled() => Err(TransportError::Cancelled),
            chunk = response.chunk() => chunk.map_err(|_| TransportError::Connection),
        };
        match result {
            Ok(Some(chunk)) => Some(Ok(chunk)),
            Ok(None) => {
                self.finish();
                None
            }
            Err(error) => {
                // 応答を捨てて接続を切る。
                self.finish();
                Some(Err(error))
            }
        }
    }

    fn finish(&mut self) {
        self.response = None;
        self.guard = None;
    }
}

impl fmt::Debug for ResponseStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResponseStream").field("head", &self.head).finish_non_exhaustive()
    }
}

/// 送信中の要求の登録。落とすと登録を外す。
struct InFlightGuard {
    in_flight: InFlight,
    request_id: String,
    token: CancellationToken,
}

impl InFlightGuard {
    fn register(in_flight: &InFlight, request_id: String) -> Result<Self, TransportError> {
        let token = CancellationToken::new();
        let mut map = lock(in_flight);
        if map.contains_key(&request_id) {
            return Err(TransportError::DuplicateRequestId);
        }
        map.insert(request_id.clone(), token.clone());
        Ok(Self { in_flight: Arc::clone(in_flight), request_id, token })
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        lock(&self.in_flight).remove(&self.request_id);
    }
}

fn lock(in_flight: &InFlight) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
    in_flight.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn response_head(status: u16, headers: &HeaderMap) -> ResponseHead {
    let [retry_after, request_id, content_type] = ALLOWED_RESPONSE_HEADERS
        .map(|name| headers.get(name).and_then(|value| value.to_str().ok()).map(str::to_owned));
    ResponseHead { status, retry_after, request_id, content_type }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use secrecy::SecretString;

    use super::*;
    use crate::destination::{Destination, ANTHROPIC_MESSAGES};
    use crate::key_store::{Provider, StoreError};

    /// `load` の中で合図を待つ保管（キーの読み出し中の中止を確かめるため。封印はクレート内でしか扱えない）。
    struct BlockingStore {
        entered: Mutex<mpsc::Sender<()>>,
        proceed: Mutex<mpsc::Receiver<()>>,
    }

    impl KeyStore for BlockingStore {
        fn set(&self, _: Provider, _: SecretString) -> Result<(), StoreError> {
            Ok(())
        }
        fn delete(&self, _: Provider) -> Result<(), StoreError> {
            Ok(())
        }
        fn contains(&self, _: Provider) -> Result<bool, StoreError> {
            Ok(true)
        }
        fn load(&self, _: Provider, _: Seal) -> Result<Option<SecretString>, StoreError> {
            self.entered.lock().unwrap().send(()).unwrap();
            self.proceed.lock().unwrap().recv().unwrap();
            Ok(Some(SecretString::from("sk-ant-dummy")))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_while_reading_the_key_stops_before_sending() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel();
        let store = BlockingStore { entered: Mutex::new(entered_tx), proceed: Mutex::new(proceed_rx) };
        // 接続されれば「接続失敗」になる宛先。中止が効いていれば送らずに「中止」で終わる。
        let table =
            DestinationTable::from_entries([(ANTHROPIC_MESSAGES, Destination::anthropic_messages("http://127.0.0.1:9/"))]);
        let transport = Arc::new(SecureTransport::new(table, Arc::new(store)).unwrap());

        let sending = tokio::spawn({
            let transport = Arc::clone(&transport);
            async move {
                let request = SendRequest {
                    request_id: "req-1".to_owned(),
                    destination: ANTHROPIC_MESSAGES.to_owned(),
                    headers: Vec::new(),
                    body: "{}".to_owned(),
                };
                transport.send(request).await.map(|_| ())
            }
        });

        tokio::task::spawn_blocking(move || entered_rx.recv().unwrap()).await.unwrap();
        assert!(transport.cancel("req-1"));
        proceed_tx.send(()).unwrap();
        assert_eq!(sending.await.unwrap(), Err(TransportError::Cancelled));
    }
}
