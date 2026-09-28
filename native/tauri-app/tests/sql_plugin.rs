//! #580 S2 の結合テスト（機能仕様 docs/features/async-db-layer.md「S2 の設計」・
//! 受入基準（S2）AC-S2-6・AC-S2-8・AC-S2-10〜12）。
//!
//! 器（`app_lib::configure`）を Tauri のテスト用の実行環境（`MockRuntime`）の
//! 上に、製品版と同じ `tauri.conf.json`・同じ capability（`generate_context!`
//! の ACL）で組み、`main` のウィンドウの IPC に plugin-sql（リポジトリ内
//! fork）のコマンドを送って確かめる。TS（直列化層・`migrate.ts`）は通らない
//! — 両版で同じ契約スイートを回すのは `npm run test:tauri-db` の役割。
//!
//! 利用者のアプリのデータディレクトリに触れないよう、テストのプロセスの
//! `HOME` を一時ディレクトリへ向け、テストごとに別の identifier（＝別の
//! データディレクトリ）で器を組む。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};

/// 製品版の DB の名前（`tauri.conf.json` の `plugins.sql.preload`）。
const DB: &str = "sqlite:ai-boss.db";

/// テストのプロセスの `HOME`（一時ディレクトリ）。最初の呼び出しで作り、
/// ほかのテストが器を組む前に `HOME` を向け替える（`OnceLock` の初期化が
/// 終わるまで、ほかのスレッドは待たされる）。
fn test_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = tempfile::Builder::new()
            .prefix("ai-boss-tauri-sql-test-")
            .tempdir()
            .expect("failed to create a temporary HOME")
            .keep();
        std::env::set_var("HOME", &dir);
        dir
    })
}

/// 器を組む。`label` ごとに identifier を変え、テスト間で DB を共有しない。
fn build_app(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    test_home();
    let mut context = app_lib::context();
    context.config_mut().identifier = format!("dev.aiboss.app.test-{label}");
    let mut app = app_lib::configure(mock_builder())
        .build(context)
        .expect("failed to build the app on MockRuntime");
    // `setup`（メインウィンドウの作成）はイベントループの Ready で走る。
    // `run` は戻らないため、未実行の `setup` を走らせる `run_iteration` を
    // 1 回だけ呼ぶ（MockRuntime の `run_iteration` 自体は何もしない）。
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let window = app
        .get_webview_window("main")
        .expect("the main window should be created by setup");
    (app, window)
}

/// `main` のウィンドウ（アプリのオリジン）から IPC の要求を送る。
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

fn execute(window: &WebviewWindow<MockRuntime>, query: &str) -> Result<Value, Value> {
    invoke(
        window,
        "plugin:sql|execute",
        json!({ "db": DB, "query": query, "values": [] }),
    )
}

fn select(window: &WebviewWindow<MockRuntime>, query: &str) -> Result<Value, Value> {
    invoke(
        window,
        "plugin:sql|select",
        json!({ "db": DB, "query": query, "values": [] }),
    )
}

// ---------------------------------------------------------------------------
// AC-S2-6: 器の ACL
// ---------------------------------------------------------------------------

#[test]
fn execute_and_select_are_allowed_from_the_main_window() {
    let (_app, window) = build_app("acl-allowed");

    execute(
        &window,
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
    )
    .expect("plugin:sql|execute should be allowed");
    let rows = select(&window, "SELECT count(*) AS n FROM items")
        .expect("plugin:sql|select should be allowed");

    assert_eq!(rows, json!([{ "n": 0 }]));
}

#[test]
fn load_is_denied_from_the_main_window() {
    let (app, window) = build_app("acl-load");

    let result = invoke(
        &window,
        "plugin:sql|load",
        json!({ "db": "sqlite:other.db" }),
    );

    assert!(
        result.is_err(),
        "plugin:sql|load should be denied: {result:?}"
    );
    let other = app.path().app_config_dir().unwrap().join("other.db");
    assert!(!other.exists(), "a denied load must not create {other:?}");
}

#[test]
fn close_is_denied_from_the_main_window() {
    let (_app, window) = build_app("acl-close");

    let result = invoke(&window, "plugin:sql|close", json!({ "db": DB }));

    assert!(
        result.is_err(),
        "plugin:sql|close should be denied: {result:?}"
    );
    // 拒否されたので DB は開いたまま使える。
    select(&window, "SELECT 1 AS one").expect("the DB should still be open");
}

// ---------------------------------------------------------------------------
// AC-S2-8: DB ファイルの場所
// ---------------------------------------------------------------------------

#[test]
fn db_file_is_created_directly_under_the_app_config_dir() {
    let (app, _window) = build_app("location");

    let config_dir = app.path().app_config_dir().unwrap();
    assert!(
        config_dir.join("ai-boss.db").is_file(),
        "ai-boss.db should be created in {config_dir:?}"
    );
    #[cfg(target_os = "macos")]
    assert_eq!(
        config_dir,
        test_home()
            .join("Library/Application Support")
            .join("dev.aiboss.app.test-location"),
    );
}

// ---------------------------------------------------------------------------
// AC-S2-10〜12: 接続 1 本
// ---------------------------------------------------------------------------

#[test]
fn concurrent_selects_all_see_a_temp_table_created_on_the_single_connection() {
    let (_app, window) = build_app("single-connection");
    // TEMP 表は作った接続からしか見えない。
    execute(
        &window,
        "CREATE TEMP TABLE only_on_this_connection (x INTEGER)",
    )
    .unwrap();

    // 1 件ずつに時間をかけ（再帰 CTE）、8 件を同時に発行して要求を重ねる。
    // プールに 2 本目の接続があれば、そこに乗った要求は TEMP 表が見えず失敗する。
    let query = "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 200000) \
                 SELECT (SELECT count(*) FROM only_on_this_connection) AS n, count(*) AS m FROM c";
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let window = window.clone();
            thread::spawn(move || select(&window, query))
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    for result in &results {
        assert_eq!(
            result,
            &Ok(json!([{ "n": 0, "m": 200000 }])),
            "every concurrent select should run on the connection that owns the TEMP table: {results:?}"
        );
    }
}

#[test]
fn begin_and_rollback_sent_as_separate_executes_undo_the_insert() {
    let (_app, window) = build_app("rollback");
    execute(
        &window,
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)",
    )
    .unwrap();

    execute(&window, "BEGIN IMMEDIATE").unwrap();
    execute(&window, "INSERT INTO items (name) VALUES ('rolled back')").unwrap();
    execute(&window, "ROLLBACK").unwrap();

    assert_eq!(
        select(&window, "SELECT count(*) AS n FROM items").unwrap(),
        json!([{ "n": 0 }])
    );
}

#[test]
fn foreign_keys_are_enabled() {
    let (_app, window) = build_app("foreign-keys");

    assert_eq!(
        select(&window, "PRAGMA foreign_keys").unwrap(),
        json!([{ "foreign_keys": 1 }])
    );
}
