//! 資格情報を付与するストリーミング転送の受入基準（S1）。送信先はすべて手元の模擬サーバー。

mod support;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use secrecy::SecretString;
use secure_transport::{
    is_valid_relay_url, Credential, Destination, DestinationTable, KeyStore, MemoryKeyStore, Provider, ResponseStream,
    SecureTransport, SendRequest, StoreError, TransportError, UnsupportedKeyStore, ANTHROPIC_MESSAGES,
    OPENAI_RESPONSES, RELAY_MESSAGES,
};
use support::{Gate, MockResponse, MockServer};

/// テスト用のダミーのキー（実在のキーではない）。
const KEY: &str = "sk-ant-dummy-registered-key-0123456789";
const OPENAI_KEY: &str = "sk-openai-dummy-registered-key-0123456789";
const BODY: &str = r#"{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"BODY-MARKER-こんにちは"}]}"#;

/// 合図で進めるテストが実装の欠陥で止まったとき、無限に待たずに落とすための安全網（正しさの判定には使わない）。
async fn within<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future).await.expect("timed out (the test is stuck)")
}

fn transport_to(url: &str, key: Option<&str>) -> SecureTransport {
    let store = MemoryKeyStore::new();
    if let Some(key) = key {
        store.set(Provider::Anthropic, SecretString::from(key)).unwrap();
    }
    let table = DestinationTable::from_entries([(ANTHROPIC_MESSAGES, Destination::anthropic_messages(url))]);
    SecureTransport::new(table, Arc::new(store)).unwrap()
}

fn request(headers: &[(&str, &str)]) -> SendRequest {
    SendRequest {
        request_id: "req-1".to_owned(),
        destination: ANTHROPIC_MESSAGES.to_owned(),
        headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
        body: BODY.to_owned(),
    }
}

async fn read_all(stream: &mut ResponseStream) -> Result<Vec<u8>, TransportError> {
    let mut body = Vec::new();
    while let Some(chunk) = stream.next_chunk().await {
        body.extend_from_slice(&chunk?);
    }
    Ok(body)
}

async fn send_ok(server: &MockServer, headers: &[(&str, &str)]) -> support::ReceivedRequest {
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(headers))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    requests.into_iter().next().unwrap()
}

fn assert_no_secret(text: &str, secret: &str) {
    assert!(!text.contains(secret), "{text:?} must not contain {secret:?}");
}

// ---- 製品版の宛先の表（機能仕様 docs/features/llm-provider-abstraction.md 受入基準（S1）「Rust の通信層」）----

/// 製品版の表の検査は、ビルド時の中継の URL（`AI_BOSS_RELAY_URL`）に依存しない内側の関数で行う
/// （機能仕様 docs/features/llm-relay-server.md 仮定 A19）。
#[test]
fn production_table_without_a_relay_url_has_exactly_anthropic_messages_and_openai_responses() {
    let table = DestinationTable::production_with(None);
    assert_eq!(table.names().collect::<Vec<_>>(), vec!["anthropic-messages", "openai-responses"]);
}

#[test]
fn production_anthropic_messages_points_to_the_messages_api() {
    let table = DestinationTable::production_with(None);
    assert_eq!(table.get("anthropic-messages").unwrap().url(), "https://api.anthropic.com/v1/messages");
}

#[test]
fn production_openai_responses_points_to_the_responses_api() {
    let table = DestinationTable::production_with(None);
    assert_eq!(table.get("openai-responses").unwrap().url(), "https://api.openai.com/v1/responses");
}

// ---- 付与するヘッダと要求の形 ----

#[tokio::test]
async fn sends_post_to_v1_messages() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[]).await;
    assert_eq!(received.method, "POST");
    assert_eq!(received.path, "/v1/messages");
}

#[tokio::test]
async fn attaches_registered_key_as_x_api_key() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[]).await;
    assert_eq!(received.header_values("x-api-key"), vec![KEY]);
}

#[tokio::test]
async fn attaches_anthropic_version_2023_06_01() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[]).await;
    assert_eq!(received.header_values("anthropic-version"), vec!["2023-06-01"]);
}

#[tokio::test]
async fn drops_caller_x_api_key() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[("X-Api-Key", "caller-supplied-api-key")]).await;
    assert_eq!(received.header_values("x-api-key"), vec![KEY]);
    assert!(received.headers.iter().all(|(_, value)| !value.contains("caller-supplied-api-key")));
}

#[tokio::test]
async fn drops_caller_authorization() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[("authorization", "Bearer caller-supplied-token")]).await;
    assert!(received.header_values("authorization").is_empty());
    assert!(received.headers.iter().all(|(_, value)| !value.contains("caller-supplied-token")));
}

#[tokio::test]
async fn drops_caller_anthropic_version() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[("anthropic-version", "1999-01-01")]).await;
    assert_eq!(received.header_values("anthropic-version"), vec!["2023-06-01"]);
    assert!(received.headers.iter().all(|(_, value)| !value.contains("1999-01-01")));
}

#[tokio::test]
async fn passes_other_caller_headers_through() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[("anthropic-beta", "some-beta-2026-01-01")]).await;
    assert_eq!(received.header_values("anthropic-beta"), vec!["some-beta-2026-01-01"]);
    assert_eq!(received.header_values("content-type"), vec!["application/json"]);
}

#[tokio::test]
async fn request_body_is_forwarded_byte_for_byte() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let received = send_ok(&server, &[]).await;
    assert_eq!(received.body, BODY.as_bytes());
}

#[tokio::test]
async fn rejects_invalid_caller_header_without_sending() {
    let server = MockServer::start(MockResponse::new(200)).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let error = within(transport.send(request(&[("bad header", "x")]))).await.unwrap_err();
    assert_eq!(error, TransportError::InvalidHeader);
    assert!(server.requests().is_empty());
}

// ---- OpenAI Bearer の資格情報（機能仕様 docs/features/llm-provider-abstraction.md 受入基準（S1）「Rust の通信層」）----

/// `anthropic-messages`（`server_a` へ）と `openai-responses`（`server_b` へ）の両方を持つ表。
/// `anthropic_key`/`openai_key` を登録した状態のキーストアを共有する。
fn dual_transport(server_a: &MockServer, server_b: &MockServer, anthropic_key: Option<&str>, openai_key: Option<&str>) -> SecureTransport {
    let store = MemoryKeyStore::new();
    if let Some(key) = anthropic_key {
        store.set(Provider::Anthropic, SecretString::from(key)).unwrap();
    }
    if let Some(key) = openai_key {
        store.set(Provider::OpenAi, SecretString::from(key)).unwrap();
    }
    let table = DestinationTable::from_entries([
        (ANTHROPIC_MESSAGES, Destination::anthropic_messages(server_a.url("/v1/messages"))),
        (OPENAI_RESPONSES, Destination::openai_responses(server_b.url("/v1/responses"))),
    ]);
    SecureTransport::new(table, Arc::new(store)).unwrap()
}

fn openai_request(headers: &[(&str, &str)]) -> SendRequest {
    SendRequest {
        request_id: "req-openai-1".to_owned(),
        destination: OPENAI_RESPONSES.to_owned(),
        headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
        body: BODY.to_owned(),
    }
}

#[tokio::test]
async fn openai_responses_attaches_registered_key_as_bearer_authorization() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, None, Some(OPENAI_KEY));
    let mut stream = within(transport.send(openai_request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = openai_server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].header_values("authorization"), vec![format!("Bearer {OPENAI_KEY}")]);
}

#[tokio::test]
async fn openai_responses_request_has_no_x_api_key_header() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, None, Some(OPENAI_KEY));
    let mut stream = within(transport.send(openai_request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    assert!(openai_server.requests()[0].header_values("x-api-key").is_empty());
}

#[tokio::test]
async fn openai_responses_request_has_no_anthropic_version_header() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, None, Some(OPENAI_KEY));
    let mut stream = within(transport.send(openai_request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    assert!(openai_server.requests()[0].header_values("anthropic-version").is_empty());
}

#[tokio::test]
async fn openai_responses_drops_caller_authorization_and_uses_the_stored_key() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, None, Some(OPENAI_KEY));
    let mut stream = within(transport.send(openai_request(&[("authorization", "Bearer caller-supplied-token")])))
        .await
        .expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = openai_server.requests();
    assert_eq!(requests[0].header_values("authorization"), vec![format!("Bearer {OPENAI_KEY}")]);
    assert!(requests[0].headers.iter().all(|(_, value)| !value.contains("caller-supplied-token")));
}

#[tokio::test]
async fn anthropic_messages_uses_the_anthropic_key_when_both_keys_are_registered() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, Some(KEY), Some(OPENAI_KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = anthropic_server.requests();
    assert_eq!(requests[0].header_values("x-api-key"), vec![KEY]);
}

#[tokio::test]
async fn anthropic_messages_request_headers_do_not_contain_the_openai_key_when_both_are_registered() {
    let anthropic_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai_server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = dual_transport(&anthropic_server, &openai_server, Some(KEY), Some(OPENAI_KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = anthropic_server.requests();
    assert!(requests[0].headers.iter().all(|(_, value)| !value.contains(OPENAI_KEY)));
}

#[tokio::test]
async fn missing_openai_key_is_rejected_without_sending() {
    let anthropic_server = MockServer::start(MockResponse::new(200)).await;
    let openai_server = MockServer::start(MockResponse::new(200)).await;
    let transport = dual_transport(&anthropic_server, &openai_server, None, None);
    let error = within(transport.send(openai_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::KeyNotRegistered);
    assert!(openai_server.requests().is_empty());
}

// ---- 送らずに失敗する場合 ----

#[tokio::test]
async fn unknown_destination_is_rejected_without_sending() {
    let server = MockServer::start(MockResponse::new(200)).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut unknown = request(&[]);
    unknown.destination = "openai-chat".to_owned();
    let error = within(transport.send(unknown)).await.unwrap_err();
    assert_eq!(error, TransportError::UnknownDestination);
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn missing_key_is_rejected_without_sending() {
    let server = MockServer::start(MockResponse::new(200)).await;
    let transport = transport_to(&server.url("/v1/messages"), None);
    let error = within(transport.send(request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::KeyNotRegistered);
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn duplicate_request_id_in_flight_is_rejected() {
    let gate = Gate::new();
    let server =
        MockServer::start(MockResponse::new(200).chunk(b"first").chunk(b"last").gate(Arc::clone(&gate))).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let _first = within(transport.send(request(&[]))).await.expect("first send");
    let error = within(transport.send(request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::DuplicateRequestId);
    assert_eq!(server.requests().len(), 1);
    gate.release();
}

// ---- 逐次の中継 ----

#[tokio::test]
async fn first_chunk_arrives_before_the_server_is_released() {
    let gate = Gate::new();
    let server = MockServer::start(
        MockResponse::new(200).chunk(b"event: first\n\n").chunk(b"event: last\n\n").gate(Arc::clone(&gate)),
    )
    .await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");

    // サーバーはまだ最後の断片を保留している（合図を出していない）。
    let first = within(stream.next_chunk()).await.expect("a chunk").expect("ok");
    assert_eq!(&first[..], b"event: first\n\n");

    gate.release();
    let rest = within(read_all(&mut stream)).await.expect("rest");
    assert_eq!(rest, b"event: last\n\n");
}

#[tokio::test]
async fn concatenated_chunks_equal_the_server_body() {
    let chunks: [&[u8]; 3] = [b"event: a\ndata: {\"x\":1}\n\n", "data: こんにちは\n\n".as_bytes(), b"event: end\n\n"];
    let mut response = MockResponse::new(200);
    for chunk in chunks {
        response = response.chunk(chunk);
    }
    let server = MockServer::start(response).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");
    let body = within(read_all(&mut stream)).await.expect("body");
    assert_eq!(body, chunks.concat());
}

// ---- 応答の頭 ----

#[tokio::test]
async fn head_status_is_the_server_status() {
    for status in [200u16, 429, 500] {
        let server = MockServer::start(MockResponse::new(status).chunk(b"{}")).await;
        let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
        let stream = within(transport.send(request(&[]))).await.expect("send");
        assert_eq!(stream.head().status, status);
    }
}

#[tokio::test]
async fn head_carries_retry_after() {
    let server = MockServer::start(MockResponse::new(429).header("retry-after", "17").chunk(b"{}")).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let stream = within(transport.send(request(&[]))).await.expect("send");
    assert_eq!(stream.head().retry_after.as_deref(), Some("17"));
}

#[tokio::test]
async fn head_carries_request_id_and_content_type() {
    let server = MockServer::start(
        MockResponse::new(200).header("request-id", "req_abc").header("content-type", "text/event-stream").chunk(b"x"),
    )
    .await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let stream = within(transport.send(request(&[]))).await.expect("send");
    assert_eq!(stream.head().request_id.as_deref(), Some("req_abc"));
    assert_eq!(stream.head().content_type.as_deref(), Some("text/event-stream"));
}

#[tokio::test]
async fn head_does_not_carry_unlisted_headers() {
    let server = MockServer::start(MockResponse::new(200).header("set-cookie", "session=secret-cookie").chunk(b"x")).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let stream = within(transport.send(request(&[]))).await.expect("send");
    assert_no_secret(&format!("{:?}", stream.head()), "secret-cookie");
}

// ---- リダイレクトに追従しない ----

const REDIRECT_STATUSES: [u16; 4] = [301, 302, 307, 308];

#[tokio::test]
async fn cross_origin_redirect_does_not_reach_the_target() {
    for status in REDIRECT_STATUSES {
        let target = MockServer::start(MockResponse::new(200).chunk(b"leaked")).await;
        let origin =
            MockServer::start(MockResponse::new(status).header("location", &target.url("/v1/messages"))).await;
        let transport = transport_to(&origin.url("/v1/messages"), Some(KEY));
        let _ = within(transport.send(request(&[]))).await;
        assert!(target.requests().is_empty(), "HTTP {status}: the redirect target received a request");
    }
}

#[tokio::test]
async fn redirect_ends_with_redirect_refused_carrying_the_status() {
    for status in REDIRECT_STATUSES {
        let target = MockServer::start(MockResponse::new(200)).await;
        let origin =
            MockServer::start(MockResponse::new(status).header("location", &target.url("/v1/messages"))).await;
        let transport = transport_to(&origin.url("/v1/messages"), Some(KEY));
        let error = within(transport.send(request(&[]))).await.unwrap_err();
        assert_eq!(error, TransportError::RedirectRefused { status });
    }
}

#[tokio::test]
async fn same_origin_redirect_is_not_followed() {
    for status in REDIRECT_STATUSES {
        let server = MockServer::start(MockResponse::new(status).header("location", "/v1/elsewhere")).await;
        let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
        let error = within(transport.send(request(&[]))).await.unwrap_err();
        assert_eq!(error, TransportError::RedirectRefused { status });
        let requests = server.requests();
        assert_eq!(requests.len(), 1, "HTTP {status}: the redirect was followed");
        assert_eq!(requests[0].path, "/v1/messages");
    }
}

// ---- 中止 ----

#[tokio::test]
async fn cancel_while_streaming_disconnects_and_ends_with_cancelled() {
    let gate = Gate::new();
    let server =
        MockServer::start(MockResponse::new(200).chunk(b"first").chunk(b"last").gate(Arc::clone(&gate))).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");
    let first = within(stream.next_chunk()).await.expect("a chunk").expect("ok");
    assert_eq!(&first[..], b"first");

    assert!(transport.cancel("req-1"));
    let ended = within(stream.next_chunk()).await;
    assert_eq!(ended, Some(Err(TransportError::Cancelled)));
    // 模擬サーバー側で接続が切れたことを観測する（最後の断片は保留したまま）。
    within(gate.disconnected()).await;
    assert_eq!(within(stream.next_chunk()).await, None);
}

#[tokio::test]
async fn cancel_before_the_response_head_disconnects_and_ends_with_cancelled() {
    let gate = Gate::new();
    let server = MockServer::start(MockResponse::new(200).chunk(b"never").gate(Arc::clone(&gate)).hold_head()).await;
    let transport = Arc::new(transport_to(&server.url("/v1/messages"), Some(KEY)));
    let sending = tokio::spawn({
        let transport = Arc::clone(&transport);
        async move { transport.send(request(&[])).await.map(|_| ()) }
    });

    // 模擬サーバーが要求を受け取り、応答の頭を保留している間に中止する。
    within(gate.received()).await;
    assert!(transport.cancel("req-1"));
    assert_eq!(within(sending).await.unwrap(), Err(TransportError::Cancelled));
    within(gate.disconnected()).await;
}

#[tokio::test]
async fn cancel_of_an_unknown_request_id_is_a_no_op() {
    let transport = transport_to("http://127.0.0.1:9/v1/messages", Some(KEY));
    assert!(!transport.cancel("no-such-request"));
}

#[tokio::test]
async fn request_id_is_released_after_the_stream_ends() {
    let server = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(&[]))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    assert!(!transport.cancel("req-1"));
    let mut again = within(transport.send(request(&[]))).await.expect("same id can be reused");
    within(read_all(&mut again)).await.expect("body");
}

// ---- キー・要求本文の非露出 ----

/// 閉じたポートの URL（接続失敗を起こす）。
async fn closed_port_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("http://127.0.0.1:{port}/v1/messages")
}

async fn every_error_kind() -> Vec<TransportError> {
    let mut errors = Vec::new();

    let server = MockServer::start(MockResponse::new(200)).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let mut unknown = request(&[]);
    unknown.destination = "nowhere".to_owned();
    errors.push(within(transport.send(unknown)).await.unwrap_err());

    let transport = transport_to(&server.url("/v1/messages"), None);
    errors.push(within(transport.send(request(&[]))).await.unwrap_err());

    let transport = transport_to(&closed_port_url().await, Some(KEY));
    errors.push(within(transport.send(request(&[]))).await.unwrap_err());

    let gate = Gate::new();
    let streaming = MockServer::start(MockResponse::new(200).chunk(b"a").chunk(b"b").gate(Arc::clone(&gate))).await;
    let transport = transport_to(&streaming.url("/v1/messages"), Some(KEY));
    let mut stream = within(transport.send(request(&[]))).await.unwrap();
    within(stream.next_chunk()).await.unwrap().unwrap();
    transport.cancel("req-1");
    errors.push(within(stream.next_chunk()).await.unwrap().unwrap_err());

    let redirecting = MockServer::start(MockResponse::new(307).header("location", "/elsewhere")).await;
    let transport = transport_to(&redirecting.url("/v1/messages"), Some(KEY));
    errors.push(within(transport.send(request(&[]))).await.unwrap_err());

    errors
}

#[tokio::test]
async fn error_values_do_not_contain_the_key() {
    let errors = every_error_kind().await;
    assert_eq!(
        errors,
        vec![
            TransportError::UnknownDestination,
            TransportError::KeyNotRegistered,
            TransportError::Connection,
            TransportError::Cancelled,
            TransportError::RedirectRefused { status: 307 },
        ]
    );
    for error in errors {
        assert_no_secret(&format!("{error:?}"), KEY);
        assert_no_secret(&error.to_string(), KEY);
    }
}

#[tokio::test]
async fn connection_error_does_not_contain_the_request_body() {
    let transport = transport_to(&closed_port_url().await, Some(KEY));
    let error = within(transport.send(request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::Connection);
    assert_no_secret(&format!("{error:?}"), "BODY-MARKER");
    assert_no_secret(&error.to_string(), "BODY-MARKER");
}

#[tokio::test]
async fn response_head_debug_does_not_contain_the_key() {
    let server = MockServer::start(MockResponse::new(200).header("request-id", "req_1").chunk(b"x")).await;
    let transport = transport_to(&server.url("/v1/messages"), Some(KEY));
    let stream = within(transport.send(request(&[]))).await.expect("send");
    assert_no_secret(&format!("{:?}", stream.head()), KEY);
    assert_no_secret(&format!("{stream:?}"), KEY);
}

#[tokio::test]
async fn openai_error_values_do_not_contain_the_registered_key() {
    let store = MemoryKeyStore::new();
    store.set(Provider::OpenAi, SecretString::from(OPENAI_KEY)).unwrap();
    let table = DestinationTable::from_entries([(
        OPENAI_RESPONSES,
        Destination::openai_responses(closed_port_url().await),
    )]);
    let transport = SecureTransport::new(table, Arc::new(store)).unwrap();
    let error = within(transport.send(openai_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::Connection);
    assert_no_secret(&format!("{error:?}"), OPENAI_KEY);
    assert_no_secret(&error.to_string(), OPENAI_KEY);
}

#[test]
fn send_request_debug_does_not_contain_the_body() {
    assert_no_secret(&format!("{:?}", request(&[("x-api-key", "caller-secret")])), "BODY-MARKER");
    assert_no_secret(&format!("{:?}", request(&[("x-api-key", "caller-secret")])), "caller-secret");
}

// ---- 中継（relay-messages）の宛先・RelayBearer の資格情報（機能仕様 docs/features/llm-relay-server.md 受入基準（S2）S2-R）----

const LICENSE: &str = "relay-license-dummy-token-0123456789";
const RELAY_URL: &str = "https://relay.example/v1/messages";

/// 3 つの宛先がそれぞれ別の模擬サーバーを指す表（保管は引数で渡した値だけを登録する）。
struct TriTransport {
    transport: SecureTransport,
    anthropic: MockServer,
    openai: MockServer,
    relay: MockServer,
}

async fn tri_transport(anthropic_key: Option<&str>, openai_key: Option<&str>, license: Option<&str>) -> TriTransport {
    tri_transport_with_relay(MockResponse::new(200).chunk(b"ok"), anthropic_key, openai_key, license).await
}

async fn tri_transport_with_relay(
    relay_response: MockResponse,
    anthropic_key: Option<&str>,
    openai_key: Option<&str>,
    license: Option<&str>,
) -> TriTransport {
    let anthropic = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let relay = MockServer::start(relay_response).await;
    let store = MemoryKeyStore::new();
    for (provider, key) in
        [(Provider::Anthropic, anthropic_key), (Provider::OpenAi, openai_key), (Provider::RelayLicense, license)]
    {
        if let Some(key) = key {
            store.set(provider, SecretString::from(key)).unwrap();
        }
    }
    let table = DestinationTable::from_entries([
        (ANTHROPIC_MESSAGES, Destination::anthropic_messages(anthropic.url("/v1/messages"))),
        (OPENAI_RESPONSES, Destination::openai_responses(openai.url("/v1/responses"))),
        (RELAY_MESSAGES, Destination::relay_messages(relay.url("/v1/messages"))),
    ]);
    let transport = SecureTransport::new(table, Arc::new(store)).unwrap();
    TriTransport { transport, anthropic, openai, relay }
}

fn relay_request(headers: &[(&str, &str)]) -> SendRequest {
    SendRequest {
        request_id: "req-relay-1".to_owned(),
        destination: RELAY_MESSAGES.to_owned(),
        headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
        body: BODY.to_owned(),
    }
}

async fn send_to_relay(tri: &TriTransport, headers: &[(&str, &str)]) -> support::ReceivedRequest {
    let mut stream = within(tri.transport.send(relay_request(headers))).await.expect("send");
    within(read_all(&mut stream)).await.expect("body");
    let requests = tri.relay.requests();
    assert_eq!(requests.len(), 1);
    requests.into_iter().next().unwrap()
}

#[test]
fn relay_messages_destination_name_is_relay_messages() {
    assert_eq!(RELAY_MESSAGES, "relay-messages");
    assert_eq!(Destination::relay_messages(RELAY_URL).credential(), Credential::RelayBearer);
    assert_eq!(Provider::RelayLicense.account(), "relay-license");
}

#[tokio::test]
async fn relay_messages_attaches_the_stored_license_as_bearer_authorization() {
    let tri = tri_transport(None, None, Some(LICENSE)).await;
    let received = send_to_relay(&tri, &[]).await;
    assert_eq!(received.header_values("authorization"), vec![format!("Bearer {LICENSE}")]);
    assert_eq!(received.body, BODY.as_bytes());
}

#[tokio::test]
async fn relay_messages_request_has_no_x_api_key_or_anthropic_version_even_with_provider_keys_registered() {
    let tri = tri_transport(Some(KEY), Some(OPENAI_KEY), Some(LICENSE)).await;
    let received = send_to_relay(&tri, &[]).await;
    assert!(received.header_values("x-api-key").is_empty());
    assert!(received.header_values("anthropic-version").is_empty());
    // Anthropic・OpenAI のキーは中継へ送らない。
    for (name, value) in &received.headers {
        assert!(!value.contains(KEY) && !value.contains(OPENAI_KEY), "{name}");
    }
}

#[tokio::test]
async fn relay_messages_drops_caller_authorization_and_x_api_key() {
    let tri = tri_transport(Some(KEY), None, Some(LICENSE)).await;
    let received = send_to_relay(
        &tri,
        &[("authorization", "Bearer caller-supplied-token"), ("X-Api-Key", "caller-supplied-api-key")],
    )
    .await;
    assert_eq!(received.header_values("authorization"), vec![format!("Bearer {LICENSE}")]);
    assert!(received.header_values("x-api-key").is_empty());
    assert!(received.headers.iter().all(|(_, value)| {
        !value.contains("caller-supplied-token") && !value.contains("caller-supplied-api-key")
    }));
}

#[tokio::test]
async fn anthropic_and_openai_requests_never_carry_the_license() {
    let tri = tri_transport(Some(KEY), Some(OPENAI_KEY), Some(LICENSE)).await;
    let mut anthropic_stream = within(tri.transport.send(request(&[]))).await.expect("anthropic send");
    within(read_all(&mut anthropic_stream)).await.expect("body");
    let mut openai_stream = within(tri.transport.send(openai_request(&[]))).await.expect("openai send");
    within(read_all(&mut openai_stream)).await.expect("body");
    for server in [&tri.anthropic, &tri.openai] {
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        for (name, value) in &requests[0].headers {
            assert_no_secret(value, LICENSE);
            assert_no_secret(name, LICENSE);
        }
    }
    assert!(tri.relay.requests().is_empty());
}

#[tokio::test]
async fn relay_messages_without_a_stored_license_fails_without_sending() {
    // Anthropic・OpenAI のキーが登録済みでも、ライセンスの代わりには使わない。
    let tri = tri_transport(Some(KEY), Some(OPENAI_KEY), None).await;
    let error = within(tri.transport.send(relay_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::KeyNotRegistered);
    assert!(tri.relay.requests().is_empty());
    assert!(tri.anthropic.requests().is_empty());
    assert!(tri.openai.requests().is_empty());
}

#[tokio::test]
async fn relay_messages_redirect_is_refused_and_the_target_receives_nothing() {
    for status in REDIRECT_STATUSES {
        let target = MockServer::start(MockResponse::new(200).chunk(b"leaked")).await;
        let tri = tri_transport_with_relay(
            MockResponse::new(status).header("location", &target.url("/v1/messages")),
            None,
            None,
            Some(LICENSE),
        )
        .await;
        let error = within(tri.transport.send(relay_request(&[]))).await.unwrap_err();
        assert_eq!(error, TransportError::RedirectRefused { status });
        assert!(target.requests().is_empty(), "HTTP {status}: the redirect target received a request");
    }
}

#[test]
fn relay_url_check_accepts_https_and_rejects_everything_else() {
    assert!(is_valid_relay_url("https://relay.example/v1/messages"));
    assert!(is_valid_relay_url("https://relay.example"));
    assert!(!is_valid_relay_url("http://relay.example/v1/messages"));
    assert!(!is_valid_relay_url(""));
    assert!(!is_valid_relay_url("https://user:pass@relay.example/v1/messages"));
    assert!(!is_valid_relay_url("https://user@relay.example/v1/messages"));
    assert!(!is_valid_relay_url("https://:pass@relay.example/v1/messages"));
    assert!(!is_valid_relay_url("not a url"));
    assert!(!is_valid_relay_url("https://"));
    assert!(!is_valid_relay_url("ftp://relay.example/v1/messages"));
    assert!(!is_valid_relay_url("relay.example/v1/messages"));
}

#[test]
fn production_with_a_valid_relay_url_adds_the_relay_messages_row() {
    let table = DestinationTable::production_with(Some(RELAY_URL));
    assert_eq!(table.names().collect::<Vec<_>>(), vec!["anthropic-messages", "openai-responses", "relay-messages"]);
    let relay = table.get(RELAY_MESSAGES).unwrap();
    assert_eq!(relay.url(), RELAY_URL);
    assert_eq!(relay.credential(), Credential::RelayBearer);
}

#[tokio::test]
async fn production_with_no_relay_url_has_two_rows_and_relay_messages_is_an_unknown_destination() {
    let table = DestinationTable::production_with(None);
    assert_eq!(table.names().collect::<Vec<_>>(), vec!["anthropic-messages", "openai-responses"]);
    assert!(table.get(RELAY_MESSAGES).is_none());
    let store = MemoryKeyStore::new();
    store.set(Provider::RelayLicense, SecretString::from(LICENSE)).unwrap();
    let transport = SecureTransport::new(table, Arc::new(store)).unwrap();
    let error = within(transport.send(relay_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::UnknownDestination);
}

#[test]
fn production_with_a_rejected_relay_url_has_only_the_two_provider_rows() {
    for url in ["http://relay.example/v1/messages", "https://user:pass@relay.example/v1/messages", "", "garbage"] {
        let table = DestinationTable::production_with(Some(url));
        assert_eq!(table.names().collect::<Vec<_>>(), vec!["anthropic-messages", "openai-responses"], "{url:?}");
    }
}

#[tokio::test]
async fn license_does_not_appear_in_debug_or_error_values() {
    let store = MemoryKeyStore::new();
    store.set(Provider::RelayLicense, SecretString::from(LICENSE)).unwrap();
    let license = SecretString::from(LICENSE);
    assert_no_secret(&format!("{license:?}"), LICENSE);
    let table = DestinationTable::from_entries([(
        RELAY_MESSAGES,
        Destination::relay_messages(closed_port_url().await),
    )]);
    assert_no_secret(&format!("{table:?}"), LICENSE);
    let transport = SecureTransport::new(table, Arc::new(store)).unwrap();
    let error = within(transport.send(relay_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::Connection);
    assert_no_secret(&format!("{error:?}"), LICENSE);
    assert_no_secret(&error.to_string(), LICENSE);

    // 保管の失敗（ヘッダに使えない値）の表示にも値は出ない。
    let store = MemoryKeyStore::new();
    let invalid = format!("{LICENSE}\nsecond-line");
    store.set(Provider::RelayLicense, SecretString::from(invalid.as_str())).unwrap();
    let table = DestinationTable::from_entries([(RELAY_MESSAGES, Destination::relay_messages(closed_port_url().await))]);
    let transport = SecureTransport::new(table, Arc::new(store)).unwrap();
    let error = within(transport.send(relay_request(&[]))).await.unwrap_err();
    assert_eq!(error, TransportError::KeyStore(secure_transport::StoreError::InvalidKeyFormat));
    assert_no_secret(&format!("{error:?}"), LICENSE);
    assert_no_secret(&error.to_string(), LICENSE);
}

// ---- 保管できない端末（#674 S1 の Android。docs/features/android-shell.md 決定 7・受入基準（S1）「秘密情報の保管」）----

/// 3 つの宛先を模擬サーバーにし、保管は [`UnsupportedKeyStore`] にする。
async fn unsupported_transport() -> TriTransport {
    let anthropic = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let openai = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let relay = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let table = DestinationTable::from_entries([
        (ANTHROPIC_MESSAGES, Destination::anthropic_messages(anthropic.url("/v1/messages"))),
        (OPENAI_RESPONSES, Destination::openai_responses(openai.url("/v1/responses"))),
        (RELAY_MESSAGES, Destination::relay_messages(relay.url("/v1/messages"))),
    ]);
    let transport = SecureTransport::new(table, Arc::new(UnsupportedKeyStore::new())).unwrap();
    TriTransport { transport, anthropic, openai, relay }
}

#[tokio::test]
async fn with_an_unsupported_store_every_credential_fails_as_a_store_failure_not_as_key_not_registered() {
    let tri = unsupported_transport().await;
    for destination in [ANTHROPIC_MESSAGES, OPENAI_RESPONSES, RELAY_MESSAGES] {
        let request = SendRequest {
            request_id: format!("req-{destination}"),
            destination: destination.to_owned(),
            headers: Vec::new(),
            body: BODY.to_owned(),
        };
        let error = within(tri.transport.send(request)).await.unwrap_err();
        assert_eq!(error, TransportError::KeyStore(StoreError::Unsupported), "{destination}");
    }
}

#[tokio::test]
async fn with_an_unsupported_store_no_request_reaches_any_destination() {
    let tri = unsupported_transport().await;
    for destination in [ANTHROPIC_MESSAGES, OPENAI_RESPONSES, RELAY_MESSAGES] {
        let request = SendRequest {
            request_id: format!("req-{destination}"),
            destination: destination.to_owned(),
            headers: Vec::new(),
            body: BODY.to_owned(),
        };
        let _ = within(tri.transport.send(request)).await;
    }
    assert!(tri.anthropic.requests().is_empty());
    assert!(tri.openai.requests().is_empty());
    assert!(tri.relay.requests().is_empty());
}

#[test]
fn an_unsupported_store_fails_set_delete_and_contains_through_the_public_port() {
    let store = UnsupportedKeyStore::new();
    assert_eq!(store.set(Provider::Anthropic, SecretString::from(KEY)), Err(StoreError::Unsupported));
    assert_eq!(store.delete(Provider::OpenAi), Err(StoreError::Unsupported));
    assert_eq!(store.contains(Provider::RelayLicense), Err(StoreError::Unsupported));
}
