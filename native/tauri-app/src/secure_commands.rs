//! 秘密情報を扱う通信層（`native/secure-transport/`）を WebView へ公開する
//! コマンドの層（機能仕様 docs/features/secure-transport-byok.md クリティカル
//! 設計決定 2・8・「IF / API（S3）」）。
//!
//! - 公開するのは [`crate::APP_COMMANDS`] の 5 つだけで、**キーの値を返す
//!   コマンドは無い**。キーの操作が返すのは成功・登録の有無だけ
//! - 送信は製品版の宛先の表（`DestinationTable::production()`）だけを使い、
//!   WebView から表や保管先を変える手段は無い（テストは [`SecureState::new`]
//!   で模擬の表とメモリの保管を注入する）
//! - 失敗は種類（とリダイレクト拒否のステータス・キーチェーンの OSStatus）
//!   だけを持つ [`CommandError`] で返し、キー・要求本文・応答本文を含めない
//! - 保管は端末ごとに選ぶ（Apple はキーチェーン。Android は S1 では保管できず、
//!   キーの操作・送信が `key-store-failure` で失敗する。#674 S1・
//!   docs/features/android-shell.md 決定 7）

use std::collections::HashMap;
use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use secure_transport::{
    DestinationTable, KeyStore, Provider, ResponseHead, ResponseStream, SecureTransport, SendRequest,
    StoreError, TransportError,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

/// コマンドの失敗（IF / API（S3）の `CommandError`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_status: Option<i32>,
}

impl CommandError {
    fn of(kind: &'static str) -> Self {
        Self { kind, status: None, os_status: None }
    }
}

impl From<StoreError> for CommandError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Keychain { status } => Self { os_status: Some(status), ..Self::of("key-store-failure") },
            // `Unsupported`（#674 S1 の Android。保管は S2）も、既存の保管の失敗の表示へ写す
            // （`key-not-registered` にしない。画面〔web/src/〕は変えない）。
            StoreError::InvalidEncoding | StoreError::InvalidKeyFormat | StoreError::Unsupported => {
                Self::of("key-store-failure")
            }
        }
    }
}

impl From<TransportError> for CommandError {
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::UnknownDestination => Self::of("unknown-destination"),
            TransportError::KeyNotRegistered => Self::of("key-not-registered"),
            TransportError::KeyStore(store) => store.into(),
            TransportError::InvalidHeader => Self::of("invalid-header"),
            TransportError::DuplicateRequestId => Self::of("duplicate-request-id"),
            TransportError::Connection => Self::of("connection"),
            TransportError::Cancelled => Self::of("cancelled"),
            TransportError::RedirectRefused { status } => Self { status: Some(status), ..Self::of("redirect-refused") },
        }
    }
}

/// `secure_send` の戻り値（応答の頭）。ヘッダは TS の転送のポートと同じ名前で返す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SendResponse {
    pub status: u16,
    pub headers: ResponseHeaders,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResponseHeaders {
    #[serde(rename = "retry-after", skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
    #[serde(rename = "request-id", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "content-type", skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

impl From<&ResponseHead> for SendResponse {
    fn from(head: &ResponseHead) -> Self {
        Self {
            status: head.status,
            headers: ResponseHeaders {
                retry_after: head.retry_after.clone(),
                request_id: head.request_id.clone(),
                content_type: head.content_type.clone(),
            },
        }
    }
}

/// `Channel` で送る本文の出来事。`end`・`error` は最後に 1 回だけ送る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum StreamEvent {
    /// 本文の断片（仮定 A17: JSON の数値の配列）。
    Chunk { data: Vec<u8> },
    End,
    Error { error: CommandError },
}

/// コマンドの状態（転送と保管）。
pub struct SecureState {
    transport: SecureTransport,
    store: Arc<dyn KeyStore>,
}

impl SecureState {
    /// 宛先の表と保管を注入して組む（テストは模擬の表とメモリの保管を渡す）。
    pub fn new(destinations: DestinationTable, store: Arc<dyn KeyStore>) -> Result<Self, CommandError> {
        let transport = SecureTransport::new(destinations, Arc::clone(&store))?;
        Ok(Self { transport, store })
    }

    /// 製品版の状態: 製品版の宛先の表と、端末の保管（[`production_key_store`]）。
    pub fn production() -> Result<Self, CommandError> {
        Self::new(DestinationTable::production(), production_key_store())
    }

    /// 送信し、応答の頭を返す。本文は `sink` へ順に渡す（`sink` が偽を返したら
    /// 中継をやめて応答を捨て、接続を切る）。
    pub async fn send<F>(&self, request: SendRequest, sink: F) -> Result<SendResponse, CommandError>
    where
        F: Fn(StreamEvent) -> bool + Send + 'static,
    {
        let stream = self.transport.send(request).await?;
        let response = SendResponse::from(stream.head());
        tauri::async_runtime::spawn(relay(stream, sink));
        Ok(response)
    }

    /// 送信中の要求を中止する。該当する要求が送信中なら真。
    pub fn cancel(&self, request_id: &str) -> bool {
        self.transport.cancel(request_id)
    }

    pub fn key_set(&self, provider: &str, key: String) -> Result<(), CommandError> {
        let provider = parse_provider(provider)?;
        let key = SecretString::from(key);
        if !is_valid_key(key.expose_secret()) {
            return Err(CommandError::of("invalid-key"));
        }
        Ok(self.store.set(provider, key)?)
    }

    pub fn key_delete(&self, provider: &str) -> Result<(), CommandError> {
        Ok(self.store.delete(parse_provider(provider)?)?)
    }

    pub fn key_status(&self, provider: &str) -> Result<bool, CommandError> {
        Ok(self.store.contains(parse_provider(provider)?)?)
    }
}

/// 製品版の保管: Apple（macOS・iOS）はキーチェーン。
#[cfg(target_vendor = "apple")]
fn production_key_store() -> Arc<dyn KeyStore> {
    Arc::new(secure_transport::KeychainKeyStore::new())
}

/// 製品版の保管: Android は S1 では保管できない（すべての操作が保管の失敗。#674 S1・
/// docs/features/android-shell.md 決定 7・A2。Android Keystore の保管は S2）。
#[cfg(target_os = "android")]
fn production_key_store() -> Arc<dyn KeyStore> {
    Arc::new(secure_transport::UnsupportedKeyStore::new())
}

/// キーのコマンドが受け付けるプロバイダは `anthropic` と `openai` だけ（#582 S2・
/// 機能仕様 docs/features/llm-provider-abstraction.md「S2 の形」）。それ以外の値
/// （大文字を含む綴り・空の文字列）は「不明なプロバイダ」。
fn parse_provider(provider: &str) -> Result<Provider, CommandError> {
    match provider {
        "anthropic" => Ok(Provider::Anthropic),
        "openai" => Ok(Provider::OpenAi),
        _ => Err(CommandError::of("unknown-provider")),
    }
}

/// 空でなく、HTTP のヘッダ値として使える（制御文字・DEL を含まない）値だけを
/// キーとして受け付ける（S1 の送信時の `HeaderValue::from_str` と同じ基準）。
fn is_valid_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|byte| (byte >= 0x20 || byte == b'\t') && byte != 0x7f)
}

async fn relay<F>(mut stream: ResponseStream, sink: F)
where
    F: Fn(StreamEvent) -> bool,
{
    loop {
        match stream.next_chunk().await {
            Some(Ok(chunk)) => {
                if !sink(StreamEvent::Chunk { data: chunk.to_vec() }) {
                    // `stream` を落として応答を捨てる（接続が切れる）。
                    return;
                }
            }
            Some(Err(error)) => {
                sink(StreamEvent::Error { error: error.into() });
                return;
            }
            None => {
                sink(StreamEvent::End);
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn secure_send(
    state: State<'_, SecureState>,
    request_id: String,
    destination: String,
    headers: HashMap<String, String>,
    body: String,
    on_event: Channel<StreamEvent>,
) -> Result<SendResponse, CommandError> {
    let request = SendRequest { request_id, destination, headers: headers.into_iter().collect(), body };
    state.send(request, move |event| on_event.send(event).is_ok()).await
}

#[tauri::command]
pub async fn secure_cancel(state: State<'_, SecureState>, request_id: String) -> Result<bool, CommandError> {
    Ok(state.cancel(&request_id))
}

#[tauri::command]
pub async fn byok_key_set(state: State<'_, SecureState>, provider: String, key: String) -> Result<(), CommandError> {
    state.key_set(&provider, key)
}

#[tauri::command]
pub async fn byok_key_delete(state: State<'_, SecureState>, provider: String) -> Result<(), CommandError> {
    state.key_delete(&provider)
}

#[tauri::command]
pub async fn byok_key_status(state: State<'_, SecureState>, provider: String) -> Result<bool, CommandError> {
    state.key_status(&provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_failure_maps_to_key_store_failure_with_the_os_status() {
        let error: CommandError = StoreError::Keychain { status: -34018 }.into();
        assert_eq!(error, CommandError { kind: "key-store-failure", status: None, os_status: Some(-34018) });
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "kind": "key-store-failure", "osStatus": -34018 })
        );
    }

    #[test]
    fn unsupported_store_maps_to_key_store_failure_without_an_os_status() {
        // #674 S1（docs/features/android-shell.md 決定 7）: 画面は既存の保管の失敗の表示を使う。
        let error: CommandError = StoreError::Unsupported.into();
        assert_eq!(error, CommandError { kind: "key-store-failure", status: None, os_status: None });
        let error: CommandError = TransportError::KeyStore(StoreError::Unsupported).into();
        assert_eq!(error, CommandError { kind: "key-store-failure", status: None, os_status: None });
        assert_eq!(serde_json::to_value(&error).unwrap(), serde_json::json!({ "kind": "key-store-failure" }));
    }

    #[test]
    fn transport_errors_map_to_the_ts_error_kinds() {
        let cases = [
            (TransportError::UnknownDestination, "unknown-destination"),
            (TransportError::KeyNotRegistered, "key-not-registered"),
            (TransportError::KeyStore(StoreError::InvalidKeyFormat), "key-store-failure"),
            (TransportError::InvalidHeader, "invalid-header"),
            (TransportError::DuplicateRequestId, "duplicate-request-id"),
            (TransportError::Connection, "connection"),
            (TransportError::Cancelled, "cancelled"),
            (TransportError::RedirectRefused { status: 307 }, "redirect-refused"),
        ];
        for (error, kind) in cases {
            assert_eq!(CommandError::from(error).kind, kind);
        }
        assert_eq!(CommandError::from(TransportError::RedirectRefused { status: 307 }).status, Some(307));
    }

    #[test]
    fn key_validation_rejects_empty_and_control_characters() {
        assert!(is_valid_key("sk-ant-api03-abc"));
        // 境界: 空白（0x20）・タブ・`~`（0x7e）は S1 の `HeaderValue::from_str` と同じく受け付ける。
        assert!(is_valid_key("sk ant"));
        assert!(is_valid_key("sk\tant"));
        assert!(is_valid_key("sk~ant"));
        assert!(!is_valid_key("sk\u{1f}ant"));
        assert!(!is_valid_key(""));
        assert!(!is_valid_key("sk-ant\nx"));
        assert!(!is_valid_key("sk-ant\rx"));
        assert!(!is_valid_key("sk-ant\u{7f}x"));
    }

    #[test]
    fn stream_events_serialize_to_the_ipc_shape() {
        assert_eq!(
            serde_json::to_value(StreamEvent::Chunk { data: vec![1, 2] }).unwrap(),
            serde_json::json!({ "event": "chunk", "data": [1, 2] })
        );
        assert_eq!(serde_json::to_value(StreamEvent::End).unwrap(), serde_json::json!({ "event": "end" }));
        assert_eq!(
            serde_json::to_value(StreamEvent::Error { error: CommandError::of("cancelled") }).unwrap(),
            serde_json::json!({ "event": "error", "error": { "kind": "cancelled" } })
        );
    }
}
