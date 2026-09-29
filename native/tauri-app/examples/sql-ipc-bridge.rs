//! IPC の中継（#580 S2・機能仕様 docs/features/async-db-layer.md「契約テストを
//! 器の上で通す仕組み」・仮定 A8）。製品のバイナリには入らない（`examples/`）。
//!
//! 器（`app_lib::configure`）を Tauri のテスト用の実行環境（`MockRuntime`）の
//! 上に、製品版と同じ `tauri.conf.json`・同じ capability（`generate_context!`
//! の ACL）で組み、標準入力で受けた IPC の要求を `main` のウィンドウ（アプリの
//! オリジン）の IPC へ渡して、結果を標準出力へ返す。web のテスト
//! （`npm run test:tauri-db`）が子プロセスとして起動し、`@tauri-apps/plugin-sql`・
//! `@tauri-apps/plugin-fs`（JS）の `invoke` をここへ流す。
//!
//! 行ごとの JSON（1 行 1 メッセージ）:
//! - 起動が済んだら `{"ready":true}` を 1 行出す。
//! - 要求 `{"id":<数>,"cmd":"plugin:sql|execute","args":{...}}` に対し、
//!   `{"id":<数>,"ok":<戻り値>}` か `{"id":<数>,"err":<エラー>}` を返す。
//!   要求はスレッドごとに並行に処理する（応答の順は要求の順と限らない）。
//! - raw の本文とヘッダ（#579 S4・仮定 A14）: 要求に `"raw":"<base64>"` があれば、
//!   本文は `args` ではなくそのバイト列（plugin-fs の `writeFile` が本文を raw で
//!   送る形）。`"headers":{"<名前>":"<値>"}` があれば要求のヘッダに載せる
//!   （`writeFile` は `path`・`options` をヘッダで送る）。応答が raw のバイト列
//!   （plugin-fs の `readFile`）のときは `{"id":<数>,"raw":"<base64>"}` を返す。
//! - 標準入力が閉じたら、処理中の要求を待って終わる。
//!
//! 利用者のアプリのデータディレクトリに触れないよう、環境変数
//! `AI_BOSS_SQL_BRIDGE_HOME`（一時ディレクトリ）を必須にし、`HOME` をそこへ
//! 向け替えてから器を組む。

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Manager;

fn main() {
    let home = std::env::var_os("AI_BOSS_SQL_BRIDGE_HOME")
        .expect("AI_BOSS_SQL_BRIDGE_HOME (a temporary directory) is required");
    std::env::set_var("HOME", home);

    let mut app = app_lib::configure(mock_builder())
        .build(app_lib::context())
        .expect("failed to build the app on MockRuntime");
    // `setup`（メインウィンドウの作成）はイベントループの Ready で走るため、
    // 未実行の `setup` を走らせる `run_iteration` を 1 回だけ呼ぶ。
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let window = app
        .get_webview_window("main")
        .expect("the main window should be created by setup");

    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    write_line(&stdout, &json!({ "ready": true }));

    let mut workers = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("failed to read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line).expect("each line must be JSON");
        let window = window.clone();
        let stdout = Arc::clone(&stdout);
        workers.push(thread::spawn(move || {
            let id = request["id"].clone();
            let cmd = request["cmd"].as_str().expect("cmd must be a string");
            let body = match request.get("raw").and_then(Value::as_str) {
                Some(encoded) => InvokeBody::Raw(
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .expect("raw must be base64"),
                ),
                None => InvokeBody::Json(request["args"].clone()),
            };
            let mut headers = HeaderMap::new();
            if let Some(map) = request.get("headers").and_then(Value::as_object) {
                for (name, value) in map {
                    headers.insert(
                        HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                        HeaderValue::from_str(value.as_str().expect("header value must be a string"))
                            .expect("header value"),
                    );
                }
            }
            let response = get_ipc_response(
                &window,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body,
                    headers,
                    invoke_key: INVOKE_KEY.to_string(),
                },
            );
            let message = match response {
                Ok(InvokeResponseBody::Json(text)) => json!({
                    "id": id,
                    "ok": serde_json::from_str::<Value>(&text).expect("response body is JSON"),
                }),
                Ok(InvokeResponseBody::Raw(bytes)) => json!({
                    "id": id,
                    "raw": base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
                Err(error) => json!({ "id": id, "err": error }),
            };
            write_line(&stdout, &message);
        }));
    }
    for worker in workers {
        worker.join().expect("a worker thread panicked");
    }
}

fn write_line(stdout: &Mutex<std::io::Stdout>, message: &Value) {
    let mut out = stdout.lock().unwrap();
    writeln!(out, "{message}").expect("failed to write stdout");
    out.flush().expect("failed to flush stdout");
}
