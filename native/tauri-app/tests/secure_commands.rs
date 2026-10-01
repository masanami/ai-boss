//! #581 S3 のコマンドの層のテスト（機能仕様 docs/features/secure-transport-byok.md
//! クリティカル設計決定 8・受入基準（S3）S3-C・S3-R・S3-K）。
//!
//! - コマンドの振る舞いは、模擬の宛先の表（手元の模擬 HTTP サーバー）とメモリの
//!   保管を注入した [`SecureState`] で確かめる。`Channel` の代わりに、送られた
//!   出来事を集める関数を渡す
//! - コマンドの名前・引数の名前・ACL は、器（`app_lib::configure_with`）を
//!   `MockRuntime` の上に製品版と同じ `tauri.conf.json`・capability で組み、
//!   `main` のウィンドウの IPC から呼んで確かめる
//!
//! 実キー・実 API・実キーチェーンは使わない。

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use app_lib::secure_commands::{CommandError, StreamEvent};
use app_lib::{SecureState, APP_COMMANDS};
use secure_transport::{
    Destination, DestinationTable, KeyStore, MemoryKeyStore, Provider, SendRequest, ANTHROPIC_MESSAGES,
    OPENAI_RESPONSES, RELAY_MESSAGES,
};
use serde_json::{json, Value};
use support::{Gate, MockResponse, MockServer};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};
use tokio::sync::mpsc;

const KEY: &str = "sk-ant-test-S3-SECRET";

/// 模擬の宛先の表（`anthropic-messages`・`openai-responses` とも模擬サーバー）と
/// メモリの保管で状態を組む。
fn state(anthropic: &MockServer, openai: &MockServer) -> SecureState {
    let table = DestinationTable::from_entries([
        (ANTHROPIC_MESSAGES, Destination::anthropic_messages(anthropic.url("/v1/messages"))),
        (OPENAI_RESPONSES, Destination::openai_responses(openai.url("/v1/responses"))),
    ]);
    SecureState::new(table, Arc::new(MemoryKeyStore::new())).expect("state")
}

fn request(request_id: &str, destination: &str) -> SendRequest {
    SendRequest {
        request_id: request_id.to_owned(),
        destination: destination.to_owned(),
        headers: Vec::new(),
        body: r#"{"model":"claude-sonnet-5"}"#.to_owned(),
    }
}

/// `Channel` の代わりに出来事を集める。
fn sink() -> (impl Fn(StreamEvent) -> bool + Send + 'static, mpsc::UnboundedReceiver<StreamEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (move |event| tx.send(event).is_ok(), rx)
}

/// `end` か `error` が届くまで集める（届いた後の送信が無いことも確かめる）。
async fn collect(mut rx: mpsc::UnboundedReceiver<StreamEvent>) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event timeout") {
        let last = !matches!(event, StreamEvent::Chunk { .. });
        events.push(event);
        if last {
            break;
        }
    }
    // 送り手（中継）が終わると受け手は閉じる。`end`・`error` の後に何も届かない。
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("close timeout"), None);
    events
}

fn chunk_bytes(events: &[StreamEvent]) -> Vec<u8> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Chunk { data } => Some(data.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

async fn servers(response: MockResponse) -> (MockServer, MockServer) {
    (MockServer::start(response).await, MockServer::start(MockResponse::new(200).chunk(b"openai")).await)
}

// --- secure_send ---------------------------------------------------------------

#[tokio::test]
async fn send_returns_the_status_of_the_destination() {
    for status in [200, 429] {
        let (anthropic, openai) = servers(MockResponse::new(status).chunk(b"x")).await;
        let state = state(&anthropic, &openai);
        state.key_set("anthropic", KEY.to_owned()).unwrap();
        let (sink, rx) = sink();
        let response = state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap();
        assert_eq!(response.status, status);
        collect(rx).await;
    }
}

#[tokio::test]
async fn send_returns_retry_after_in_the_headers() {
    let (anthropic, openai) = servers(MockResponse::new(429).header("retry-after", "3").chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, rx) = sink();
    let response = state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap();
    assert_eq!(response.headers.retry_after.as_deref(), Some("3"));
    assert_eq!(serde_json::to_value(&response).unwrap()["headers"]["retry-after"], json!("3"));
    collect(rx).await;
}

#[tokio::test]
async fn chunks_relayed_through_the_channel_match_the_body_and_end_once() {
    let (anthropic, openai) =
        servers(MockResponse::new(200).chunk("data: 上".as_bytes()).chunk("司\n\n".as_bytes()).chunk(b"done")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, rx) = sink();
    state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap();
    let events = collect(rx).await;
    assert_eq!(chunk_bytes(&events), "data: 上司\n\ndone".as_bytes());
    assert_eq!(events.last(), Some(&StreamEvent::End));
    assert_eq!(events.iter().filter(|event| **event == StreamEvent::End).count(), 1);
}

#[tokio::test]
async fn unknown_destination_is_refused_without_sending() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, _rx) = sink();
    let error = state.send(request("r", "https://example.com/v1/messages"), sink).await.unwrap_err();
    assert_eq!(error.kind, "unknown-destination");
    assert!(anthropic.requests().is_empty());
    assert!(openai.requests().is_empty());
}

#[tokio::test]
async fn openai_destination_without_an_openai_key_is_not_sent() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, _rx) = sink();
    let error = state.send(request("r", OPENAI_RESPONSES), sink).await.unwrap_err();
    assert_eq!(error.kind, "key-not-registered");
    assert!(openai.requests().is_empty());
}

#[tokio::test]
async fn caller_x_api_key_is_replaced_by_the_stored_key() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, rx) = sink();
    let mut send = request("r", ANTHROPIC_MESSAGES);
    send.headers = vec![("x-api-key".to_owned(), "sk-ant-attacker".to_owned())];
    state.send(send, sink).await.unwrap();
    collect(rx).await;
    let received = anthropic.requests();
    assert_eq!(received[0].header_values("x-api-key"), vec![KEY]);
}

#[tokio::test]
async fn send_without_a_registered_key_fails_with_key_not_registered() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    let (sink, _rx) = sink();
    let error = state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap_err();
    assert_eq!(error.kind, "key-not-registered");
    assert!(anthropic.requests().is_empty());
}

#[tokio::test]
async fn redirect_is_refused_with_the_status() {
    let (anthropic, openai) =
        servers(MockResponse::new(302).header("location", "http://127.0.0.1:9/elsewhere").chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, _rx) = sink();
    let error = state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap_err();
    assert_eq!(error, CommandError { kind: "redirect-refused", status: Some(302), os_status: None });
}

#[tokio::test]
async fn duplicate_request_id_fails_without_disturbing_the_first_request() {
    let gate = Gate::new();
    let (anthropic, openai) =
        servers(MockResponse::new(200).chunk(b"first").chunk(b"-rest").gate(Arc::clone(&gate))).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (first_sink, mut first_rx) = sink();
    state.send(request("same", ANTHROPIC_MESSAGES), first_sink).await.unwrap();
    // 最初の断片が届いた（送信中）ことを確かめてから、同じ `requestId` で送る。
    let first_event = first_rx.recv().await.unwrap();

    let (second_sink, _second_rx) = sink();
    let error = state.send(request("same", ANTHROPIC_MESSAGES), second_sink).await.unwrap_err();
    assert_eq!(error.kind, "duplicate-request-id");

    gate.release();
    let mut events = vec![first_event];
    events.extend(collect(first_rx).await);
    assert_eq!(chunk_bytes(&events), b"first-rest");
    assert_eq!(events.last(), Some(&StreamEvent::End));
}

#[tokio::test]
async fn cancel_while_sending_ends_the_channel_with_cancelled_and_disconnects() {
    let gate = Gate::new();
    let (anthropic, openai) =
        servers(MockResponse::new(200).chunk(b"first").chunk(b"-rest").gate(Arc::clone(&gate))).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, mut rx) = sink();
    state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap();
    assert!(matches!(rx.recv().await, Some(StreamEvent::Chunk { .. })));

    assert!(state.cancel("r"));
    let events = collect(rx).await;
    assert_eq!(events.last(), Some(&StreamEvent::Error { error: error_of("cancelled") }));
    tokio::time::timeout(Duration::from_secs(5), gate.disconnected()).await.expect("the connection should be closed");
}

#[tokio::test]
async fn cancel_after_the_end_returns_false() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (sink, rx) = sink();
    state.send(request("r", ANTHROPIC_MESSAGES), sink).await.unwrap();
    collect(rx).await;
    assert!(!state.cancel("r"));
}

#[tokio::test]
async fn failing_channel_stops_relaying_and_disconnects() {
    let gate = Gate::new();
    let (anthropic, openai) =
        servers(MockResponse::new(200).chunk(b"first").chunk(b"-rest").gate(Arc::clone(&gate))).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    // 最初の断片から送れない `Channel`（WebView が閉じた等）。
    state.send(request("r", ANTHROPIC_MESSAGES), |_event| false).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), gate.disconnected()).await.expect("the connection should be closed");
}

/// S3-R14（`secure_send` の戻り値・失敗・`Channel`）と S3-R16（他の 4 つのコマンドの
/// 戻り値・失敗）を、同じシナリオの出力をまとめて直列化して確かめる。
#[tokio::test]
async fn key_never_appears_in_command_results_errors_or_channel_events() {
    let mut outputs: Vec<Value> = Vec::new();

    // 成功（本文を最後まで）
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"hello")).await;
    let state = state(&anthropic, &openai);
    outputs.push(serde_json::to_value(state.key_set("anthropic", KEY.to_owned())).unwrap());
    outputs.push(serde_json::to_value(state.key_status("anthropic")).unwrap());
    let (ok_sink, rx) = sink();
    outputs.push(serde_json::to_value(state.send(request("ok", ANTHROPIC_MESSAGES), ok_sink).await).unwrap());
    outputs.extend(collect(rx).await.iter().map(|event| serde_json::to_value(event).unwrap()));
    outputs.push(serde_json::to_value(state.cancel("ok")).unwrap());
    // 宛先不明・キー未登録（OpenAI）
    for destination in ["nowhere", OPENAI_RESPONSES] {
        let (s, _rx) = sink();
        outputs.push(serde_json::to_value(state.send(request("e", destination), s).await).unwrap());
    }
    // キーの失敗（不明なプロバイダ。#582 S2 から `openai` は受け付けるため別の名前で）
    outputs.push(serde_json::to_value(state.key_set("google", KEY.to_owned())).unwrap());
    outputs.push(serde_json::to_value(state.key_status("google")).unwrap());
    outputs.push(serde_json::to_value(state.key_delete("google")).unwrap());

    // リダイレクト拒否
    let (redirect, openai2) = servers(MockResponse::new(302).header("location", "http://127.0.0.1:9/").chunk(b"x")).await;
    let redirect_state = self::state(&redirect, &openai2);
    redirect_state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (s, _rx) = sink();
    outputs.push(serde_json::to_value(redirect_state.send(request("r", ANTHROPIC_MESSAGES), s).await).unwrap());

    // 要求 ID の重複と中止
    let gate = Gate::new();
    let (held, openai3) = servers(MockResponse::new(200).chunk(b"a").chunk(b"b").gate(Arc::clone(&gate))).await;
    let held_state = self::state(&held, &openai3);
    held_state.key_set("anthropic", KEY.to_owned()).unwrap();
    let (s, mut rx) = sink();
    outputs.push(serde_json::to_value(held_state.send(request("h", ANTHROPIC_MESSAGES), s).await).unwrap());
    outputs.push(serde_json::to_value(rx.recv().await.unwrap()).unwrap());
    let (dup, _dup_rx) = sink();
    outputs.push(serde_json::to_value(held_state.send(request("h", ANTHROPIC_MESSAGES), dup).await).unwrap());
    outputs.push(serde_json::to_value(held_state.cancel("h")).unwrap());
    outputs.extend(collect(rx).await.iter().map(|event| serde_json::to_value(event).unwrap()));
    outputs.push(serde_json::to_value(held_state.key_delete("anthropic")).unwrap());

    let text = serde_json::to_string(&outputs).unwrap();
    assert!(text.contains("duplicate-request-id") && text.contains("redirect-refused") && text.contains("cancelled"));
    assert!(!text.contains(KEY), "{text}");
}

// --- キーのコマンド -------------------------------------------------------------

fn memory_state() -> SecureState {
    SecureState::new(DestinationTable::from_entries::<&str>([]), Arc::new(MemoryKeyStore::new())).unwrap()
}

fn error_of(kind: &'static str) -> CommandError {
    CommandError { kind, status: None, os_status: None }
}

#[test]
fn registered_key_is_reported_as_present() {
    let state = memory_state();
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    assert_eq!(state.key_status("anthropic"), Ok(true));
}

#[test]
fn deleted_key_is_reported_as_absent() {
    let state = memory_state();
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    state.key_delete("anthropic").unwrap();
    assert_eq!(state.key_status("anthropic"), Ok(false));
}

#[test]
fn deleting_an_absent_key_succeeds() {
    assert_eq!(memory_state().key_delete("anthropic"), Ok(()));
}

#[test]
fn key_set_refuses_an_empty_key() {
    let state = memory_state();
    assert_eq!(state.key_set("anthropic", String::new()), Err(error_of("invalid-key")));
    assert_eq!(state.key_status("anthropic"), Ok(false));
}

#[test]
fn key_set_refuses_a_key_with_a_newline() {
    let state = memory_state();
    assert_eq!(state.key_set("anthropic", format!("{KEY}\n")), Err(error_of("invalid-key")));
    assert_eq!(state.key_status("anthropic"), Ok(false));
}

// --- キーのコマンド（OpenAI・#582 S2。機能仕様 docs/features/llm-provider-abstraction.md
// 受入基準（S2）S2-K1〜S2-K10）------------------------------------------------------

const OPENAI_KEY: &str = "sk-proj-test-S2-SECRET";

/// S2-K1
#[test]
fn s2_k1_openai_key_is_reported_as_present_after_registration() {
    let state = memory_state();
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    assert_eq!(state.key_status("openai"), Ok(true));
}

/// S2-K2
#[test]
fn s2_k2_registering_the_openai_key_leaves_anthropic_unregistered() {
    let state = memory_state();
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    assert_eq!(state.key_status("anthropic"), Ok(false));
}

/// S2-K3
#[test]
fn s2_k3_deleting_the_openai_key_keeps_the_anthropic_key() {
    let state = memory_state();
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    state.key_delete("openai").unwrap();
    assert_eq!(state.key_status("openai"), Ok(false));
    assert_eq!(state.key_status("anthropic"), Ok(true));
}

/// S2-K4（旧 S3-K4・S3-K6・S3-K7 の置き換え: `anthropic`・`openai` 以外は不明なプロバイダ）
#[test]
fn s2_k4_key_commands_refuse_unknown_providers_and_store_nothing() {
    for provider in ["google", "OpenAI", "Anthropic", ""] {
        let state = memory_state();
        assert_eq!(state.key_set(provider, KEY.to_owned()), Err(error_of("unknown-provider")), "{provider}");
        assert_eq!(state.key_delete(provider), Err(error_of("unknown-provider")), "{provider}");
        assert_eq!(state.key_status(provider), Err(error_of("unknown-provider")), "{provider}");
        assert_eq!(state.key_status("anthropic"), Ok(false), "{provider}");
        assert_eq!(state.key_status("openai"), Ok(false), "{provider}");
    }
}

/// S2-K5
#[test]
fn s2_k5_openai_key_set_refuses_an_empty_key_or_a_newline() {
    for key in [String::new(), format!("{OPENAI_KEY}\n")] {
        let state = memory_state();
        assert_eq!(state.key_set("openai", key), Err(error_of("invalid-key")));
        assert_eq!(state.key_status("openai"), Ok(false));
    }
}

/// S2-K6
#[tokio::test]
async fn s2_k6_openai_key_registered_by_command_is_sent_as_a_bearer_token() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    let (s, rx) = sink();
    state.send(request("o", OPENAI_RESPONSES), s).await.unwrap();
    collect(rx).await;
    let requests = openai.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].header_values("authorization"), vec![format!("Bearer {OPENAI_KEY}").as_str()]);
}

/// S2-K7
#[tokio::test]
async fn s2_k7_only_an_openai_key_does_not_send_to_anthropic() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    let (s, _rx) = sink();
    assert_eq!(state.send(request("a", ANTHROPIC_MESSAGES), s).await.unwrap_err(), error_of("key-not-registered"));
    assert!(anthropic.requests().is_empty());
}

/// S2-K8
#[tokio::test]
async fn s2_k8_anthropic_request_never_carries_the_openai_key() {
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"x")).await;
    let state = state(&anthropic, &openai);
    state.key_set("anthropic", KEY.to_owned()).unwrap();
    state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    let (s, rx) = sink();
    state.send(request("a", ANTHROPIC_MESSAGES), s).await.unwrap();
    collect(rx).await;
    let requests = anthropic.requests();
    assert_eq!(requests.len(), 1);
    for (name, value) in &requests[0].headers {
        assert!(!value.contains(OPENAI_KEY), "{name}");
    }
    assert_eq!(requests[0].header_values("x-api-key"), vec![KEY]);
}

/// S2-K9・S2-K10: OpenAI のキーを登録した後の、5 つのコマンドの戻り値・失敗の値の JSON、
/// `Channel` へ送った値の JSON、失敗の値の `Debug` にそのキーが現れない。
#[tokio::test]
async fn s2_k9_k10_openai_key_never_appears_in_command_results_errors_channel_events_or_debug() {
    let mut outputs: Vec<Value> = Vec::new();
    let mut debugs: Vec<String> = Vec::new();
    let record = |outputs: &mut Vec<Value>, debugs: &mut Vec<String>, value: Value, debug: String| {
        outputs.push(value);
        debugs.push(debug);
    };

    // 成功（本文を最後まで）
    let (anthropic, openai) = servers(MockResponse::new(200).chunk(b"hello")).await;
    let state = state(&anthropic, &openai);
    let r = state.key_set("openai", OPENAI_KEY.to_owned());
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    let r = state.key_status("openai");
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    let (ok_sink, rx) = sink();
    let r = state.send(request("ok", OPENAI_RESPONSES), ok_sink).await;
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    for event in collect(rx).await {
        record(&mut outputs, &mut debugs, serde_json::to_value(&event).unwrap(), format!("{event:?}"));
    }
    let r = state.cancel("ok");
    record(&mut outputs, &mut debugs, serde_json::to_value(r).unwrap(), format!("{r:?}"));
    // 宛先不明・キー未登録（Anthropic）
    for destination in ["nowhere", ANTHROPIC_MESSAGES] {
        let (s, _rx) = sink();
        let r = state.send(request("e", destination), s).await;
        record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    }
    // 不明なプロバイダ・不正なキー
    let r = state.key_set("google", OPENAI_KEY.to_owned());
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    let r = state.key_set("openai", format!("{OPENAI_KEY}\n"));
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));

    // リダイレクト拒否
    let anthropic2 = MockServer::start(MockResponse::new(200).chunk(b"x")).await;
    let redirect = MockServer::start(MockResponse::new(302).header("location", "http://127.0.0.1:9/").chunk(b"x")).await;
    let redirect_state = self::state(&anthropic2, &redirect);
    redirect_state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    let (s, _rx) = sink();
    let r = redirect_state.send(request("r", OPENAI_RESPONSES), s).await;
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));

    // 要求 ID の重複と中止
    let gate = Gate::new();
    let held = MockServer::start(MockResponse::new(200).chunk(b"a").chunk(b"b").gate(Arc::clone(&gate))).await;
    let anthropic3 = MockServer::start(MockResponse::new(200).chunk(b"x")).await;
    let held_state = self::state(&anthropic3, &held);
    held_state.key_set("openai", OPENAI_KEY.to_owned()).unwrap();
    let (s, mut rx) = sink();
    let r = held_state.send(request("h", OPENAI_RESPONSES), s).await;
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    let first = rx.recv().await.unwrap();
    record(&mut outputs, &mut debugs, serde_json::to_value(&first).unwrap(), format!("{first:?}"));
    let (dup, _dup_rx) = sink();
    let r = held_state.send(request("h", OPENAI_RESPONSES), dup).await;
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));
    let r = held_state.cancel("h");
    record(&mut outputs, &mut debugs, serde_json::to_value(r).unwrap(), format!("{r:?}"));
    for event in collect(rx).await {
        record(&mut outputs, &mut debugs, serde_json::to_value(&event).unwrap(), format!("{event:?}"));
    }
    let r = held_state.key_delete("openai");
    record(&mut outputs, &mut debugs, serde_json::to_value(&r).unwrap(), format!("{r:?}"));

    let text = serde_json::to_string(&outputs).unwrap();
    for kind in ["unknown-destination", "key-not-registered", "unknown-provider", "invalid-key", "redirect-refused", "duplicate-request-id", "cancelled"] {
        assert!(text.contains(kind), "{kind} was not exercised: {text}");
    }
    assert!(!text.contains(OPENAI_KEY), "{text}");
    for debug in &debugs {
        assert!(!debug.contains(OPENAI_KEY), "{debug}");
    }
}

// --- IPC（名前・引数の名前・ACL） ---------------------------------------------

/// テストのプロセスの `HOME`（plugin-sql の preload がアプリのデータディレクトリに
/// DB を作るため、利用者のディレクトリに触れないよう向け替える。tests/sql_plugin.rs と同じ）。
fn test_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("secure-commands-home");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create the test HOME");
        std::env::set_var("HOME", &dir);
        dir
    })
}

fn build_app(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    test_home();
    let mut context = app_lib::context();
    context.config_mut().identifier = format!("dev.aiboss.app.secure-{label}");
    let state = SecureState::new(DestinationTable::from_entries::<&str>([]), Arc::new(MemoryKeyStore::new())).unwrap();
    let mut app = app_lib::configure_with(mock_builder(), state)
        .build(context)
        .expect("failed to build the app on MockRuntime");
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let window = app.get_webview_window("main").expect("the main window should be created by setup");
    (app, window)
}

fn invoke(window: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("response body is JSON"))
}

#[test]
fn app_commands_are_exactly_the_five() {
    assert_eq!(
        APP_COMMANDS,
        ["secure_send", "secure_cancel", "byok_key_set", "byok_key_delete", "byok_key_status"]
    );
}

#[test]
fn every_app_command_is_reachable_over_ipc_with_the_ts_argument_names() {
    let (_app, window) = build_app("reachable");
    assert_eq!(invoke(&window, "byok_key_status", json!({ "provider": "anthropic" })), Ok(json!(false)));
    assert_eq!(invoke(&window, "byok_key_set", json!({ "provider": "anthropic", "key": KEY })), Ok(Value::Null));
    assert_eq!(invoke(&window, "byok_key_status", json!({ "provider": "anthropic" })), Ok(json!(true)));
    assert_eq!(invoke(&window, "secure_cancel", json!({ "requestId": "nothing" })), Ok(json!(false)));
    // 空の宛先の表なので、コマンドに届けば「宛先不明」で終わる（ACL・引数の
    // 解釈で拒否された場合はこの形にならない）。
    assert_eq!(
        invoke(
            &window,
            "secure_send",
            json!({
                "requestId": "r1",
                "destination": "anthropic-messages",
                "headers": {},
                "body": "{}",
                "onEvent": "__CHANNEL__:1",
            }),
        ),
        Err(json!({ "kind": "unknown-destination" }))
    );
    assert_eq!(invoke(&window, "byok_key_delete", json!({ "provider": "anthropic" })), Ok(Value::Null));
    assert_eq!(invoke(&window, "byok_key_status", json!({ "provider": "anthropic" })), Ok(json!(false)));
}

#[test]
fn commands_that_would_return_the_key_do_not_exist() {
    let (_app, window) = build_app("no-getter");
    invoke(&window, "byok_key_set", json!({ "provider": "anthropic", "key": KEY })).unwrap();
    for cmd in ["byok_key_get", "byok_key_load", "keychain_get"] {
        let result = invoke(&window, cmd, json!({ "provider": "anthropic" }));
        assert!(result.is_err(), "{cmd} should fail: {result:?}");
        assert!(!format!("{result:?}").contains(KEY));
    }
}

// --- relay-license はキーのコマンドで触れない（機能仕様 docs/features/llm-relay-server.md
// 受入基準（S2）S2-R。決定 S2-Q3）--------------------------------------------------

const LICENSE: &str = "relay-license-test-S2-SECRET";

/// ライセンストークンを保管へ直接登録した状態（登録の経路は #584。ここは保管を直接書く）。
fn relay_state(relay: &MockServer) -> (SecureState, Arc<MemoryKeyStore>) {
    let store = Arc::new(MemoryKeyStore::new());
    store.set(Provider::RelayLicense, secrecy::SecretString::from(LICENSE)).unwrap();
    let table = DestinationTable::from_entries([(RELAY_MESSAGES, Destination::relay_messages(relay.url("/v1/messages")))]);
    (SecureState::new(table, store.clone()).unwrap(), store)
}

#[tokio::test]
async fn s2_r_key_commands_refuse_relay_license_and_leave_the_stored_token_unchanged() {
    let relay = MockServer::start(MockResponse::new(200).chunk(b"ok")).await;
    let (state, store) = relay_state(&relay);

    assert_eq!(state.key_set("relay-license", "attacker-token".to_owned()), Err(error_of("unknown-provider")));
    assert_eq!(state.key_delete("relay-license"), Err(error_of("unknown-provider")));
    assert_eq!(state.key_status("relay-license"), Err(error_of("unknown-provider")));

    // 保管の項目は残り、値も変わっていない（中継へ送ると保管したトークンが付く）。
    assert!(store.contains(Provider::RelayLicense).unwrap());
    let (s, rx) = sink();
    state.send(request("r", RELAY_MESSAGES), s).await.unwrap();
    collect(rx).await;
    let requests = relay.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].header_values("authorization"), vec![format!("Bearer {LICENSE}").as_str()]);
}

#[tokio::test]
async fn s2_r_license_never_appears_in_command_results_errors_channel_events_or_debug() {
    let relay = MockServer::start(MockResponse::new(200).chunk(b"hello")).await;
    let (state, _store) = relay_state(&relay);
    let mut texts: Vec<String> = Vec::new();

    let r = state.key_set("relay-license", "attacker-token".to_owned());
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));
    let r = state.key_delete("relay-license");
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));
    let r = state.key_status("relay-license");
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));

    let (s, rx) = sink();
    let r = state.send(request("ok", RELAY_MESSAGES), s).await;
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));
    for event in collect(rx).await {
        texts.push(format!("{event:?}{}", serde_json::to_string(&event).unwrap()));
    }

    // 保管に無い・宛先に無いときの失敗の値。
    let empty = SecureState::new(
        DestinationTable::from_entries([(RELAY_MESSAGES, Destination::relay_messages(relay.url("/v1/messages")))]),
        Arc::new(MemoryKeyStore::new()),
    )
    .unwrap();
    let (s, _rx) = sink();
    let r = empty.send(request("none", RELAY_MESSAGES), s).await;
    assert_eq!(r.as_ref().unwrap_err(), &error_of("key-not-registered"));
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));
    let (s, _rx) = sink();
    let r = state.send(request("nowhere", "nowhere"), s).await;
    texts.push(format!("{r:?}{}", serde_json::to_string(&r).unwrap()));

    for text in texts {
        assert!(!text.contains(LICENSE), "{text}");
    }
}
