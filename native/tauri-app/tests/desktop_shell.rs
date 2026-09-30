//! #579 S3 の結合テスト（機能仕様 docs/features/tauri-in-app-runtime.md「S3 の
//! 設計」・受入基準（S3）AC-S3-2・AC-S3-12・AC-S3-13・AC-S3-15〜17）。
//!
//! 器（`app_lib::configure`）を Tauri のテスト用の実行環境（`MockRuntime`）の
//! 上に、製品版と同じ `tauri.conf.json`・同じ capability（`generate_context!`
//! の ACL）で組む（`tests/sql_plugin.rs` と同じ形）。
//!
//! **`plugin:notification|notify` は、どのテストからも呼ばない**（許可された
//! 形で呼ぶと開発機に本物の通知が出る。権限の有無は `tests/config_checks.rs`
//! の capability の検査と、呼べないコマンドの拒否で確かめる）。メニューバーの
//! アイコン（本物のステータスアイテム）も作らない — `configure` は作らず、
//! `run` だけが作る。
//!
//! 利用者のアプリのデータディレクトリに触れないよう、テストのプロセスの
//! `HOME` を一時ディレクトリへ向け、テストごとに別の identifier で器を組む。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, AppHandle, Listener, Manager, RunEvent, WebviewWindow, WindowEvent};

use app_lib::desktop_shell::{
    handle_run_event, spawn_minute_ticker_with, MinuteTicker, MINUTE_TICK_EVENT,
};

/// `sql_plugin.rs` とは別のディレクトリ（並列に走る別のテストバイナリと、
/// 先頭の「空にする」処理が競合しないように）。
fn test_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("desktop-shell-home");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create the test HOME");
        std::env::set_var("HOME", &dir);
        dir
    })
}

/// 器を組む。`label` ごとに identifier を変え、テスト間で DB を共有しない。
///
/// `setup` が起こした本物の刻みの送り手は、返す前に止める（`MinuteTicker::stop`）。
/// 止めないと実際の分の境界でテストのアプリへ刻みを送り続け、刻みの回数を
/// 正確に数えられない（止めた後は 1 回も送らない。止める前の刻みは、テストが
/// 購読を登録する前なので数えられない）。
fn build_app(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let (app, window) = build_app_with_live_ticker(label);
    app.state::<MinuteTicker>().stop();
    (app, window)
}

/// 器を組み、`setup` が起こした本物の刻みの送り手を動かしたまま返す。
fn build_app_with_live_ticker(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    test_home();
    let mut context = app_lib::context();
    context.config_mut().identifier = format!("dev.aiboss.app.desktop-shell-{label}");
    let mut app = app_lib::configure(mock_builder())
        .build(context)
        .expect("failed to build the app on MockRuntime");
    // `setup`（メインウィンドウの作成・刻みの送り手の起動）はイベントループの
    // Ready で走る。`run` は戻らない/遅いため、未実行の `setup` を走らせる
    // `run_iteration` を 1 回だけ呼ぶ。
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

/// 製品の `run` と同じ実行イベントの処理（`handle_run_event`）でイベントループを
/// 回し、メインのウィンドウに閉じる要求（`close`）を送り、その
/// 要求が処理された後の最初のループで `after_close` を呼び、最後にウィンドウを
/// 破棄してループを終える。
///
/// `MockRuntime` は、イベントループが動いている間だけ `close` を閉じる要求
/// （`CloseRequested`）として処理する（動く前は要求を経ずに取り除く）。終了の
/// 要求（`request_exit`）は未実装のため、`exit` は呼ばない。
fn close_main_then(
    app: App<MockRuntime>,
    after_close: impl FnOnce(&AppHandle<MockRuntime>) + 'static,
) {
    // 同じプロセスで複数の `App::run`（`MockRuntime`）を並行に回すと、テストの
    // プロセスが不定期に落ちた（SIGSEGV・SIGABRT・SIGTRAP。2026-09-29 に 2 本を
    // 並行に回して 30 回中 3 回前後で再現。原因は未調査）。イベントループを回す
    // テストは 1 本ずつ直列に走らせる。
    static ONE_LOOP_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ONE_LOOP_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let mut after_close = Some(after_close);
    let mut close_requested = false;
    app.run(move |handle, event| {
        // 観測してから、製品の `run` と同じ処理（`handle_run_event`）へそのまま渡す。
        match &event {
            RunEvent::Ready => {
                handle
                    .get_webview_window("main")
                    .expect("the main window exists before the close request")
                    .close()
                    .unwrap();
            }
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => close_requested = true,
            RunEvent::MainEventsCleared if close_requested => {
                if let Some(after_close) = after_close.take() {
                    after_close(handle);
                    if let Some(window) = handle.get_webview_window("main") {
                        window.destroy().unwrap();
                    }
                }
            }
            _ => {}
        }
        handle_run_event(handle, event);
    });
}

const TICKER_TIMEOUT: Duration = Duration::from_secs(10);

/// 分の境界から 30 秒過ぎた固定の時刻（1_700_000_040 は分の境界）。
fn thirty_seconds_into_a_minute() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_700_000_040 + 30)
}

/// 製品と同じ組み立て（`spawn_minute_ticker_with`: 製品の待ち・製品の送り・
/// 別スレッド）で送り手を起こし、眠り方だけを差し替えて待ちを `rounds` 回だけ
/// 終わらせる。`rounds + 1` 回目の待ちに入った時点で、それまでの刻みは送り
/// 終えている。送り手を止め、スレッドが終わるのを確かめてから、各回の眠りの
/// 長さを返す。
///
/// 失敗は panic ではなく `Err` で返す（イベントループのコールバックの中からも
/// 呼ぶため）。
fn tick_n_times(handle: &AppHandle<MockRuntime>, rounds: usize) -> Result<Vec<Duration>, String> {
    let (started_tx, started_rx) = mpsc::channel::<Duration>();
    let (permit_tx, permit_rx) = mpsc::channel::<()>();
    let ticker = spawn_minute_ticker_with(handle.clone(), thirty_seconds_into_a_minute, move |d| {
        let _ = started_tx.send(d);
        let _ = permit_rx.recv();
    })
    .map_err(|e| format!("failed to spawn the ticker: {e}"))?;

    let mut slept = Vec::new();
    for round in 0..=rounds {
        let duration = started_rx
            .recv_timeout(TICKER_TIMEOUT)
            .map_err(|e| format!("the ticker did not start wait #{} ({e})", round + 1))?;
        if round == rounds {
            break;
        }
        slept.push(duration);
        permit_tx.send(()).map_err(|e| e.to_string())?;
    }

    ticker.stop();
    drop(permit_tx);
    let deadline = Instant::now() + TICKER_TIMEOUT;
    while ticker.is_running() {
        if Instant::now() > deadline {
            return Err("the ticker thread did not finish after stop".into());
        }
        std::thread::yield_now();
    }
    Ok(slept)
}

// ---------------------------------------------------------------------------
// AC-S3-2: 閉じる要求の後もメインのウィンドウは残る
// ---------------------------------------------------------------------------

#[test]
fn main_window_survives_a_close_request() {
    let (app, _window) = build_app("close-survives");
    let survived = Arc::new(AtomicUsize::new(usize::MAX));

    let observed = survived.clone();
    close_main_then(app, move |handle| {
        observed.store(
            usize::from(handle.get_webview_window("main").is_some()),
            Ordering::SeqCst,
        );
    });

    assert_eq!(
        survived.load(Ordering::SeqCst),
        1,
        "the main window must still exist after the close request (it is hidden, not destroyed)"
    );
}

// ---------------------------------------------------------------------------
// AC-S3-12: 閉じる要求の後も刻みはメインのウィンドウへ届く
// ---------------------------------------------------------------------------

#[test]
fn minute_ticks_still_reach_the_main_window_after_a_close_request() {
    let (app, window) = build_app("ticks-after-close");
    // メインのウィンドウ自身に登録した購読（宛先がメインのウィンドウのときだけ
    // 届き、ウィンドウが破棄されれば外れる）で受け取る。
    let received = Arc::new(AtomicUsize::new(0));
    let counter = received.clone();
    window.listen(MINUTE_TICK_EVENT, move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    let outcome = Arc::new(Mutex::new(None));
    let observed = outcome.clone();
    close_main_then(app, move |handle| {
        // 製品の組み立ての送り手に、閉じる要求の後で 3 回の待ちを終わらせる。
        *observed.lock().unwrap() = Some(tick_n_times(handle, 3));
    });

    let slept = outcome
        .lock()
        .unwrap()
        .take()
        .expect("the ticker ran after the close request")
        .unwrap_or_else(|e| panic!("{e}"));
    // 製品の待ち: 境界まで（30 秒）＋マージン（100 ms）を、毎回眠る。
    assert_eq!(slept, [Duration::from_millis(30_100); 3]);
    // 1 回の待ちで 1 回ずつ、閉じる要求の後もメインのウィンドウへ届く。
    assert_eq!(
        received.load(Ordering::SeqCst),
        3,
        "the main window should receive exactly one tick per finished wait after the close request"
    );
}

#[test]
fn a_tick_is_addressed_to_the_main_window_only() {
    let (app, window) = build_app("ticks-main-only");
    let other = tauri::WebviewWindowBuilder::new(
        &app,
        "evidence-1",
        tauri::WebviewUrl::App("app.html".into()),
    )
    .build()
    .unwrap();
    let on_main = Arc::new(AtomicUsize::new(0));
    let on_other = Arc::new(AtomicUsize::new(0));
    let main_counter = on_main.clone();
    window.listen(MINUTE_TICK_EVENT, move |_| {
        main_counter.fetch_add(1, Ordering::SeqCst);
    });
    let other_counter = on_other.clone();
    other.listen(MINUTE_TICK_EVENT, move |_| {
        other_counter.fetch_add(1, Ordering::SeqCst);
    });

    tick_n_times(app.handle(), 1).unwrap_or_else(|e| panic!("{e}"));

    assert_eq!(on_main.load(Ordering::SeqCst), 1);
    assert_eq!(on_other.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// AC-S3-13: 刻みの送り手が起動している
// ---------------------------------------------------------------------------

#[test]
fn setup_starts_the_minute_ticker() {
    let (app, _window) = build_app_with_live_ticker("ticker-started");

    let ticker = app
        .try_state::<MinuteTicker>()
        .expect("setup should start the minute ticker and manage its handle");
    // 起動したスレッドが（次の分の境界まで眠っていて）しばらく経っても終わって
    // いないこと。送り手が起動直後に終わる退行を検出する（起動した直後の 1 回
    // だけ見ると、終わる前のスレッドを見て通ってしまう）。起動したスレッドが
    // 待ち・送りを製品の組み立てで行うことは `tick_n_times` を使うテストが確かめる。
    let watch_until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < watch_until {
        assert!(ticker.is_running(), "the minute ticker thread should keep running");
        std::thread::sleep(Duration::from_millis(10));
    }
    ticker.stop();
}

// ---------------------------------------------------------------------------
// 通知のプラグインが登録されている（呼ばずに、器の状態で確かめる）
// ---------------------------------------------------------------------------

#[test]
fn setup_registers_the_notification_plugin() {
    let (app, _window) = build_app("notification-plugin");

    // プラグインは初期化のときに自分の状態（`Notification`）を `manage` する。
    // 通知そのものは送らない（`show` を呼ばない）。
    assert!(app
        .try_state::<tauri_plugin_notification::Notification<MockRuntime>>()
        .is_some());
}

// ---------------------------------------------------------------------------
// AC-S3-15〜17: 足さない権限は拒否される
// ---------------------------------------------------------------------------

/// ACL が拒否したときのエラーの文言（コマンドが無いときも同じ節を含むため、
/// 「そのコマンドを許可する権限」の名前まで確かめて、コマンドの綴りの誤りで
/// 通らないようにする）。
fn assert_denied_for_lack_of_permission(result: Result<Value, Value>, permission: &str) {
    let message = match result {
        Ok(value) => panic!("the command should have been denied, but it returned {value}"),
        Err(error) => error.to_string(),
    };
    assert!(
        message.contains("not allowed"),
        "expected an ACL denial, got: {message}"
    );
    assert!(
        message.contains(permission),
        "the denial should name the missing permission {permission}: {message}"
    );
}

#[test]
fn request_permission_is_denied_from_the_main_window() {
    let (_app, window) = build_app("acl-request-permission");

    let result = invoke(&window, "plugin:notification|request_permission", json!({}));

    assert_denied_for_lack_of_permission(result, "notification:allow-request-permission");
}

#[test]
fn is_permission_granted_is_denied_from_the_main_window() {
    let (_app, window) = build_app("acl-is-permission-granted");

    let result = invoke(
        &window,
        "plugin:notification|is_permission_granted",
        json!({}),
    );

    assert_denied_for_lack_of_permission(result, "notification:allow-is-permission-granted");
}

#[test]
fn emitting_events_is_denied_from_the_main_window() {
    let (_app, window) = build_app("acl-emit");

    let result = invoke(
        &window,
        "plugin:event|emit",
        json!({ "event": "minute-tick", "payload": null }),
    );

    assert_denied_for_lack_of_permission(result, "core:event:allow-emit");
}

#[test]
fn listening_to_events_is_allowed_from_the_main_window() {
    // 上の拒否が「イベントの API 全体が使えない」ためではないことの対照。
    let (_app, window) = build_app("acl-listen");

    let result = invoke(
        &window,
        "plugin:event|listen",
        json!({
            "event": MINUTE_TICK_EVENT,
            "target": { "kind": "Any" },
            "handler": 1234,
        }),
    );

    assert!(
        result.is_ok(),
        "plugin:event|listen should be allowed: {result:?}"
    );
}

// ---------------------------------------------------------------------------
// S3-A5: メニューバーのアイコンに使う既定のアイコン
// ---------------------------------------------------------------------------

#[test]
fn the_context_embeds_a_default_window_icon_for_the_tray() {
    let context = app_lib::context::<MockRuntime>();

    assert!(context.default_window_icon().is_some());
}

// ---------------------------------------------------------------------------
// #659: 多重起動の防止（single-instance）
// ---------------------------------------------------------------------------

/// 製品の組み立て（`app_lib::with_single_instance`）で器を組むと、2 つ目の起動を
/// 受ける口（macOS では `/tmp/<identifier>_si.sock` の Unix ソケット）が開き、
/// 2 つ目の起動の知らせ（作業ディレクトリと引数）を受け付ける。2 つ目の起動は
/// この口へ知らせて終了する（`tauri-plugin-single-instance` 2.5 の macOS の実装）。
///
/// 利用者が起動している本物のアプリ（`dev.aiboss.app`）の口と取り違えると、
/// テストのプロセスが 2 つ目の起動として終了するため、プロセスごとに別の
/// identifier で組む。
#[cfg(target_os = "macos")]
#[test]
fn the_product_assembly_listens_for_a_second_instance() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    test_home();
    let identifier = format!("dev.aiboss.app.single-instance-test-{}", std::process::id());
    let socket = PathBuf::from(format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_")));
    let _ = std::fs::remove_file(&socket);
    let mut context = app_lib::context();
    context.config_mut().identifier = identifier;
    let mut app = app_lib::configure(app_lib::with_single_instance(mock_builder()))
        .build(context)
        .expect("failed to build the app on MockRuntime");
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    app.state::<MinuteTicker>().stop();

    // 口は非同期に開くため、開くまで待つ。
    let deadline = Instant::now() + TICKER_TIMEOUT;
    let stream = loop {
        match UnixStream::connect(&socket) {
            Ok(stream) => break stream,
            Err(error) if Instant::now() > deadline => {
                panic!("the single-instance socket {} did not open: {error}", socket.display())
            }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    (&stream)
        .write_all(b"/\0\0ai-boss")
        .expect("a second instance can notify the first one");

    tauri_plugin_single_instance::destroy(&app);
    assert!(!socket.exists(), "the socket should be removed by destroy");
}

/// single-instance が非同期に開く待ち受けのソケットを、開くのを待ってから消す
/// （`/tmp` に残さない。開かないまま時間切れになったら何もしない）。
fn remove_single_instance_socket(socket: &Path) {
    let deadline = Instant::now() + TICKER_TIMEOUT;
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(socket);
}

/// 製品の組み立てで器を組むと、アプリのデータディレクトリの錠（#659）を取り、
/// 器が生きているあいだ持ち続ける（ほぼ同時の 2 つ目の起動は錠を取れない）。
#[cfg(target_os = "macos")]
#[test]
fn the_product_assembly_holds_the_instance_lock() {
    test_home();
    let identifier = format!("dev.aiboss.app.instance-lock-held-{}", std::process::id());
    let socket = PathBuf::from(format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_")));
    let mut context = app_lib::context();
    context.config_mut().identifier = identifier;
    let mut app = app_lib::configure(app_lib::with_single_instance(mock_builder()))
        .build(context)
        .expect("failed to build the app on MockRuntime");
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    app.state::<MinuteTicker>().stop();
    let config_dir = app.path().app_config_dir().unwrap();

    let second = app_lib::acquire_instance_lock(&config_dir).unwrap();

    remove_single_instance_socket(&socket);
    assert!(second.is_none(), "the running app should hold the instance lock");
}

/// 錠を別の持ち手（先に起動したプロセス）が持っていると、製品の組み立ては錠の
/// プラグインの初期化で失敗し、DB の preload（plugin-sql）・`setup`（刻みの送り手の
/// 起動）へ進まない（#659。ほぼ同時の 2 つの起動のうち、錠を取れなかった方）。
#[cfg(target_os = "macos")]
#[test]
fn the_product_assembly_stops_before_the_db_when_the_instance_lock_is_held() {
    test_home();
    let identifier = format!("dev.aiboss.app.instance-lock-busy-{}", std::process::id());
    let socket = PathBuf::from(format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_")));
    let config_dir = test_home()
        .join("Library/Application Support")
        .join(&identifier);
    let _held = app_lib::acquire_instance_lock(&config_dir)
        .unwrap()
        .expect("the test should get the lock first");
    let mut context = app_lib::context();
    context.config_mut().identifier = identifier;

    let result = app_lib::configure(app_lib::with_single_instance(mock_builder())).build(context);

    remove_single_instance_socket(&socket);
    match result {
        Err(tauri::Error::PluginInitialization(name, _)) => {
            assert_eq!(name, app_lib::INSTANCE_LOCK_PLUGIN_NAME)
        }
        Err(other) => panic!("unexpected build error: {other}"),
        Ok(_) => panic!("the build should fail while another process holds the lock"),
    }
    assert!(
        !config_dir.join("ai-boss.db").exists(),
        "the DB must not be opened by the instance that did not get the lock"
    );
}
