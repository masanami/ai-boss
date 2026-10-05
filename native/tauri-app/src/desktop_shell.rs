//! デスクトップの常駐（機能仕様 `docs/features/tauri-in-app-runtime.md`
//! 「S3 の設計」）: ウィンドウを閉じてもアプリを終了せずメニューバーに残し、
//! 毎分の刻みを WebView へ送る。
//!
//! 判定（閉じる要求を取り消すか・メニューの項目から何をするか・再表示の要求で
//! 何をするか・次の刻みまでの待ち時間）は、ラベル・項目の ID・時刻を受け取る
//! **純粋な関数**にして `cargo test` で固定する。Tauri の API を呼ぶ部分
//! （トレイ・ウィンドウの表示・`exit`・スレッドの起動）は薄く保つ（仮定 S3-A7:
//! `MockRuntime` は `hide`・`show` を観測できず、終了の要求は未実装のため）。

use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// #669 S1（機能仕様 docs/features/ios-shell.md 決定 1）: トレイはデスクトップだけに
// ある（モバイルの tauri には `menu`・`tray` のモジュールが無い）。
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;
use tauri::utils::config::{BackgroundThrottlingPolicy, WindowConfig};
use tauri::{AppHandle, Emitter, EventTarget, Manager, RunEvent, Runtime, WebviewUrl, WindowEvent};

/// メインのウィンドウのラベル。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 製品版の web のエントリ（`web/dist-app/app.html`）。
const MAIN_WINDOW_URL: &str = "app.html";

/// Rust 側から WebView へ毎分送る刻みのイベントの名前（仮定 S3-A2）。
/// `web/src/app-entry/start-product-scheduler.ts` の `MINUTE_TICK_EVENT` と一致させる。
pub const MINUTE_TICK_EVENT: &str = "minute-tick";

// ---------------------------------------------------------------------------
// ウィンドウを閉じる要求（AC-S3-1）
// ---------------------------------------------------------------------------

/// 閉じる要求への応答。
#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// 閉じずに隠す（ウィンドウを破棄しない。WebView とコア・毎分の検知は動き続ける）。
    HideInstead,
    /// そのまま閉じる。
    Close,
}

/// 閉じる要求の判定。メインのウィンドウは隠す。それ以外（証跡の新しいウィンドウ
/// など）は閉じる。
pub fn close_decision(label: &str) -> CloseDecision {
    if label == MAIN_WINDOW_LABEL {
        CloseDecision::HideInstead
    } else {
        CloseDecision::Close
    }
}

// ---------------------------------------------------------------------------
// メニューバー（トレイ）（AC-S3-3〜7）
// ---------------------------------------------------------------------------

pub const MENU_ID_OPEN: &str = "open";
pub const MENU_ID_QUIT: &str = "quit";

/// メニューの項目の定義（ID と表示名）。
#[derive(Debug, PartialEq, Eq)]
pub struct MenuItemSpec {
    pub id: &'static str,
    pub label: &'static str,
}

/// メニューバーのメニューの項目。「ウィンドウを開く」「終了」の 2 つだけで、この順。
pub fn tray_menu_items() -> [MenuItemSpec; 2] {
    [
        MenuItemSpec {
            id: MENU_ID_OPEN,
            label: "ウィンドウを開く",
        },
        MenuItemSpec {
            id: MENU_ID_QUIT,
            label: "終了",
        },
    ]
}

/// メニュー・再表示の要求から引く操作。
#[derive(Debug, PartialEq, Eq)]
pub enum ShellAction {
    /// メインのウィンドウを表示して前面に出す。
    ShowMainWindow,
    /// アプリを終了する。
    Quit,
}

/// メニューの項目の ID から操作を引く。項目に無い ID は `None`。
pub fn menu_action(id: &str) -> Option<ShellAction> {
    match id {
        MENU_ID_OPEN => Some(ShellAction::ShowMainWindow),
        MENU_ID_QUIT => Some(ShellAction::Quit),
        _ => None,
    }
}

/// Dock のアイコンを押したとき（`RunEvent::Reopen`）の判定。見えているウィンドウが
/// 無ければメインのウィンドウを表示する（隠したウィンドウを Dock から戻せるように）。
pub fn reopen_action(has_visible_windows: bool) -> Option<ShellAction> {
    if has_visible_windows {
        None
    } else {
        Some(ShellAction::ShowMainWindow)
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        // 最小化はデスクトップだけにある（#669 S1・決定 1）。
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn perform<R: Runtime>(app: &AppHandle<R>, action: ShellAction) {
    match action {
        ShellAction::ShowMainWindow => show_main_window(app),
        ShellAction::Quit => app.exit(0),
    }
}

/// 2 つ目の起動を知らされたとき（#659）: 既にあるメインのウィンドウを表示して前面に
/// 出す（2 つ目の起動のプロセスは、錠を取れずに器の組み立てが失敗した `run` が、既にあるプロセスへ知らせてから終える。#664）。
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>) {
    perform(app, ShellAction::ShowMainWindow);
}

/// メニューバーのアイコンとメニューを作る。`run` の `RunEvent::Ready` から呼ぶ
/// （`configure`・`handle_run_event` では作らない — メニューは実際の macOS の
/// メニュー〔muda〕でメインスレッドを要し、`MockRuntime` の結合テストが本物の
/// ステータスアイテムを作らないように）。アイコンはアプリの既定のアイコン
/// （仮定 S3-A5）。デスクトップだけ（#669 S1・決定 1）。
#[cfg(desktop)]
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let items = tray_menu_items()
        .iter()
        .map(|spec| MenuItem::with_id(app, spec.id, spec.label, true, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    let menu = Menu::with_items(app, &item_refs)?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| {
            if let Some(action) = menu_action(event.id().as_ref()) {
                perform(app, action);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// アプリの実行イベントの処理（`App::run` のコールバック）: 閉じる要求と Dock の
/// 再表示の要求。メニューバーのアイコン（`create_tray`。本物のステータスアイテム）
/// は含めない — `MockRuntime` の結合テストがこの関数を経由するため。
pub fn handle_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        // 閉じる要求（閉じるボタン・⌘W）。判定は `close_decision`。`Builder::
        // on_window_event` ではなくここで扱う: 実行環境は両方へ同じ要求（同じ
        // 取り消しの口）を渡すが、`MockRuntime` は前者を呼ばず、後者だけが結合テスト
        // （`tests/desktop_shell.rs`）で観測できる。
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if close_decision(&label) == CloseDecision::HideInstead {
                api.prevent_close();
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.hide();
                }
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if let Some(action) = reopen_action(has_visible_windows) {
                perform(app, action);
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// メインのウィンドウの設定（AC-S3-8・AC-S3-9）
// ---------------------------------------------------------------------------

/// メインのウィンドウの設定。`tauri.conf.json` の `app.windows` は空のまま、コードで
/// 組んで `WebviewWindowBuilder::from_config` へ渡す（設定値をテストで検査できる
/// ようにするため。仮定 S3-A4）。
///
/// `background_throttling: Disabled`: 既定では、隠れた・最小化された WebView が
/// 約 5 分後に間引かれ、止まると Rust から送った刻みの処理も止まる（機能仕様
/// 「S3 の設計」の実測）。
pub fn main_window_config() -> WindowConfig {
    WindowConfig {
        label: MAIN_WINDOW_LABEL.into(),
        url: WebviewUrl::App(MAIN_WINDOW_URL.into()),
        title: "ai-boss".into(),
        background_throttling: Some(BackgroundThrottlingPolicy::Disabled),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// 毎分の刻み（AC-S3-10〜13）
// ---------------------------------------------------------------------------

const MINUTE: Duration = Duration::from_secs(60);

/// 製品の待ちで境界の後に足す余裕。眠りは単調時計で数え、境界は壁時計で決めるため、
/// 時計の補正で数ミリ秒早く起きると WebView の `new Date()` が前の分（hh:mm:59.9x）を
/// 読み、その分の検知が抜けうる。境界を確実に越えてから刻みを送る。
const TICK_MARGIN: Duration = Duration::from_millis(100);

/// 製品の眠りを区切る最大の長さ（#659）。Mac のスリープ中は眠り（単調時計）が
/// 進まないため、1 回で境界まで眠ると復帰の後に最初の刻みが最大で約 60 秒遅れる。
/// 区切るたびに壁時計を確かめ直し、復帰から最大でこの長さの後に刻みを送る。
const WAKE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// 次の刻み（次の分の境界＝秒 0）までの待ち時間。境界ちょうどなら 60 秒。
pub fn duration_until_next_minute(now: SystemTime) -> Duration {
    // 1970-01-01 より前の時計は 0（境界）として扱う。
    let since_epoch = now.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let into_minute = Duration::from_nanos((since_epoch.as_nanos() % MINUTE.as_nanos()) as u64);
    MINUTE - into_minute
}

/// 刻みの送り手のループ。待ちが終わるたびに `emit` を 1 回呼ぶ。待ちの長さは
/// 毎回 `now` から計算し直す（遅れても次の刻みで境界へ戻り、ずれが積み上がらない。
/// 仮定 S3-A2）。`wait` が `Break` を返したら終わる（製品では終わらない。
/// テストは即時に返す `wait` で回数を数える）。
pub fn run_minute_ticker(
    mut now: impl FnMut() -> SystemTime,
    mut wait: impl FnMut(Duration) -> ControlFlow<()>,
    mut emit: impl FnMut(),
) {
    while wait(duration_until_next_minute(now())).is_continue() {
        emit();
    }
}

/// 刻みのイベントをメインのウィンドウだけへ送る。
pub fn emit_minute_tick<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.emit_to(
        EventTarget::webview_window(MAIN_WINDOW_LABEL),
        MINUTE_TICK_EVENT,
        (),
    )
}

/// 製品の待ち: 次の分の境界まで `sleep` で眠り（境界の後に `TICK_MARGIN` を
/// 足す）、刻みを続ける（`Continue`）。製品では `sleep` は `sleep_until_wall_clock`
/// （区切って壁時計を確かめる `std::thread::sleep`）。
/// 眠り方を引数で受け取り、マージンの加算と `Continue` を返すことをユニット
/// テストで固定する。
pub fn wait_for_next_tick(duration: Duration, sleep: &mut impl FnMut(Duration)) -> ControlFlow<()> {
    sleep(duration + TICK_MARGIN);
    ControlFlow::Continue(())
}

/// 製品の眠り方（#659）: `duration` だけ眠る。ただし `WAKE_CHECK_INTERVAL` ごとに
/// 区切って壁時計（`now`）を確かめ、眠り始めの壁時計から `duration` 後の時刻を
/// 過ぎていれば（スリープから復帰した）、残りを眠らずに戻る。壁時計が戻っても、
/// 眠りの合計は `duration` を越えない（1 回で眠るのより遅れない）。
pub fn sleep_until_wall_clock(
    duration: Duration,
    mut now: impl FnMut() -> SystemTime,
    mut sleep: impl FnMut(Duration),
) {
    let deadline = now() + duration;
    let mut slept = Duration::ZERO;
    while slept < duration {
        let Ok(until_deadline) = deadline.duration_since(now()) else {
            return;
        };
        let step = until_deadline
            .min(duration - slept)
            .min(WAKE_CHECK_INTERVAL);
        if step.is_zero() {
            return;
        }
        sleep(step);
        slept += step;
    }
}

/// 起動した刻みの送り手。`setup` で `manage` し、起動したことを器の状態として
/// 観測できるようにする（AC-S3-13。仮定 S3-A8）。
pub struct MinuteTicker {
    thread: JoinHandle<()>,
    stopped: Arc<Mutex<bool>>,
}

impl MinuteTicker {
    /// 送り手のスレッドが動いている（終わっていない）か。
    pub fn is_running(&self) -> bool {
        !self.thread.is_finished()
    }

    /// 以後の刻みを送らないようにする。戻った後に刻みは 1 回も送られない
    /// （送っている途中なら、その送信の完了を待って戻る）。眠っている途中の
    /// スレッドは、起きたところで終わる。製品は呼ばない — テストが `setup` の
    /// 起こした本物の送り手を止め、刻みの回数を正確に数えるため。
    pub fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
    }
}

/// 刻みの送り手を別スレッドで起動する。次の分の境界まで眠っては刻みを送る。
pub fn spawn_minute_ticker<R: Runtime>(app: AppHandle<R>) -> std::io::Result<MinuteTicker> {
    spawn_minute_ticker_with(app, SystemTime::now, |duration| {
        sleep_until_wall_clock(duration, SystemTime::now, std::thread::sleep)
    })
}

/// [`spawn_minute_ticker`] の本体。時計（`now`）と眠り方（`sleep`）だけを受け取り、
/// 待ち（[`wait_for_next_tick`]）・送り（[`emit_minute_tick`]）・スレッドの起動は
/// 製品と同じ組み立てを使う（テストは眠り方を差し替えて、起動したスレッドが
/// 実際に刻みを送ることを数える）。
pub fn spawn_minute_ticker_with<R: Runtime>(
    app: AppHandle<R>,
    now: impl FnMut() -> SystemTime + Send + 'static,
    mut sleep: impl FnMut(Duration) + Send + 'static,
) -> std::io::Result<MinuteTicker> {
    let stopped = Arc::new(Mutex::new(false));
    let thread_stopped = stopped.clone();
    let is_stopped = move || *thread_stopped.lock().unwrap_or_else(|e| e.into_inner());
    let emit_stopped = stopped.clone();
    let thread = std::thread::Builder::new()
        .name("minute-ticker".into())
        .spawn(move || {
            run_minute_ticker(
                now,
                |duration| {
                    let flow = wait_for_next_tick(duration, &mut sleep);
                    if is_stopped() {
                        ControlFlow::Break(())
                    } else {
                        flow
                    }
                },
                || {
                    // 止める要求（`stop`）と競合しないよう、確かめてから送り終えるまで
                    // 錠を持つ。
                    let stopped = emit_stopped.lock().unwrap_or_else(|e| e.into_inner());
                    if *stopped {
                        return;
                    }
                    if let Err(error) = emit_minute_tick(&app) {
                        eprintln!("failed to emit {MINUTE_TICK_EVENT}: {error}");
                    }
                },
            );
        })?;
    Ok(MinuteTicker { thread, stopped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    // --- minute-tick のイベント名 (AC-S3-11) ------------------------------------

    #[test]
    fn the_tick_event_is_named_minute_tick() {
        // TS 側（`start-product-scheduler.ts` の `MINUTE_TICK_EVENT`）と文字列で一致
        // させる。定数だけが変わっても刻みが届かなくなるため、文字列のまま固定する。
        assert_eq!(MINUTE_TICK_EVENT, "minute-tick");
    }

    // --- close_decision (AC-S3-1) ----------------------------------------------

    #[test]
    fn close_decision_hides_the_main_window() {
        assert_eq!(close_decision("main"), CloseDecision::HideInstead);
    }

    #[test]
    fn close_decision_lets_other_windows_close() {
        // 証跡の新しいウィンドウ（`window.open` が作るウィンドウのラベル）など。
        assert_eq!(close_decision("evidence-1"), CloseDecision::Close);
        assert_eq!(close_decision(""), CloseDecision::Close);
        assert_eq!(close_decision("Main"), CloseDecision::Close);
    }

    // --- tray menu (AC-S3-3〜6) ------------------------------------------------

    #[test]
    fn tray_menu_has_exactly_open_and_quit_in_this_order() {
        let items = tray_menu_items();
        let labels: Vec<_> = items.iter().map(|item| item.label).collect();

        assert_eq!(labels, ["ウィンドウを開く", "終了"]);
    }

    #[test]
    fn open_item_maps_to_showing_the_main_window() {
        let open = &tray_menu_items()[0];

        assert_eq!(menu_action(open.id), Some(ShellAction::ShowMainWindow));
    }

    #[test]
    fn quit_item_maps_to_quitting() {
        let quit = &tray_menu_items()[1];

        assert_eq!(menu_action(quit.id), Some(ShellAction::Quit));
    }

    #[test]
    fn unknown_menu_id_maps_to_no_action() {
        assert_eq!(menu_action("nope"), None);
        assert_eq!(menu_action(""), None);
        // 表示名は ID ではない。
        assert_eq!(menu_action("終了"), None);
    }

    #[test]
    fn menu_item_ids_are_unique() {
        let items = tray_menu_items();

        assert_ne!(items[0].id, items[1].id);
    }

    // --- reopen (AC-S3-7) ------------------------------------------------------

    #[test]
    fn reopen_shows_the_main_window_when_no_window_is_visible() {
        assert_eq!(reopen_action(false), Some(ShellAction::ShowMainWindow));
    }

    #[test]
    fn reopen_does_nothing_when_a_window_is_visible() {
        assert_eq!(reopen_action(true), None);
    }

    // --- main_window_config (AC-S3-8・AC-S3-9) ---------------------------------

    #[test]
    fn main_window_disables_background_throttling() {
        assert_eq!(
            main_window_config().background_throttling,
            Some(BackgroundThrottlingPolicy::Disabled)
        );
    }

    #[test]
    fn main_window_loads_the_product_web_entry() {
        assert_eq!(main_window_config().url, WebviewUrl::App("app.html".into()));
    }

    #[test]
    fn main_window_has_the_main_label_and_title() {
        let config = main_window_config();

        assert_eq!(config.label, "main");
        assert_eq!(config.title, "ai-boss");
    }

    // --- duration_until_next_minute (AC-S3-10) ---------------------------------

    fn at(secs: u64, nanos: u32) -> SystemTime {
        UNIX_EPOCH + Duration::new(secs, nanos)
    }

    #[test]
    fn exactly_on_a_minute_boundary_waits_a_full_minute() {
        assert_eq!(
            duration_until_next_minute(at(1_700_000_040, 0)),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn one_millisecond_after_the_boundary_waits_59_999_ms() {
        assert_eq!(
            duration_until_next_minute(at(1_700_000_040, 1_000_000)),
            Duration::from_millis(59_999)
        );
    }

    #[test]
    fn thirty_seconds_into_the_minute_waits_thirty_seconds() {
        assert_eq!(
            duration_until_next_minute(at(1_700_000_040 + 30, 0)),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn one_millisecond_before_the_next_boundary_waits_one_millisecond() {
        assert_eq!(
            duration_until_next_minute(at(1_700_000_040 + 59, 999_000_000)),
            Duration::from_millis(1)
        );
    }

    #[test]
    fn a_clock_before_the_epoch_waits_a_full_minute() {
        assert_eq!(
            duration_until_next_minute(UNIX_EPOCH - Duration::from_secs(5)),
            Duration::from_secs(60)
        );
    }

    // --- wait_for_next_tick (AC-S3-10・AC-S3-11) ---------------------------------

    #[test]
    fn the_product_wait_sleeps_past_the_boundary_by_the_margin() {
        let mut slept = Vec::new();

        let _ = wait_for_next_tick(Duration::from_secs(30), &mut |d| slept.push(d));

        assert_eq!(slept, [Duration::from_millis(30_100)]);
    }

    #[test]
    fn the_product_wait_keeps_ticking() {
        assert_eq!(
            wait_for_next_tick(Duration::from_secs(60), &mut |_| {}),
            ControlFlow::Continue(())
        );
    }

    // --- sleep_until_wall_clock（#659: スリープからの復帰） ----------------------

    /// 眠った分だけ進む時計。`jumps` の i 番目の値を、i 回目の眠りの後にさらに
    /// 足す（負は戻す）。Mac のスリープ中は眠り（単調時計）が進まず壁時計だけが
    /// 進むことを、眠りの後の壁時計の飛びで模擬する。
    fn run_sleep_until_wall_clock(duration: Duration, jumps: &[i64]) -> Vec<Duration> {
        let clock = Cell::new(at(1_700_000_070, 0));
        let slept = RefCell::new(Vec::new());

        sleep_until_wall_clock(
            duration,
            || clock.get(),
            |d| {
                let i = slept.borrow().len();
                slept.borrow_mut().push(d);
                let jump = jumps.get(i).copied().unwrap_or(0);
                let advanced = clock.get() + d;
                clock.set(if jump >= 0 {
                    advanced + Duration::from_secs(jump as u64)
                } else {
                    advanced - Duration::from_secs(jump.unsigned_abs())
                });
            },
        );

        slept.into_inner()
    }

    #[test]
    fn sleeps_in_slices_of_at_most_five_seconds_until_the_duration_has_passed() {
        assert_eq!(
            run_sleep_until_wall_clock(Duration::from_millis(12_100), &[]),
            [
                Duration::from_secs(5),
                Duration::from_secs(5),
                Duration::from_millis(2_100),
            ]
        );
    }

    #[test]
    fn a_duration_within_one_slice_is_slept_at_once() {
        assert_eq!(
            run_sleep_until_wall_clock(Duration::from_secs(5), &[]),
            [Duration::from_secs(5)]
        );
    }

    #[test]
    fn stops_after_the_slice_in_which_the_wall_clock_jumped_past_the_deadline() {
        // 2 回目の眠りの間に Mac が 10 分スリープした: 壁時計は期限を越えたので、
        // 残りの約 20 秒を眠らずに戻る（刻みが復帰から 1 区切り以内に送られる）。
        assert_eq!(
            run_sleep_until_wall_clock(Duration::from_millis(30_100), &[0, 600]),
            [Duration::from_secs(5), Duration::from_secs(5)]
        );
    }

    #[test]
    fn a_jump_that_leaves_the_wall_clock_short_of_the_deadline_sleeps_only_the_rest() {
        // 1 回目の眠りの間に壁時計が 20 秒進んだ: 期限まで残り 5.1 秒だけ眠る。
        assert_eq!(
            run_sleep_until_wall_clock(Duration::from_millis(30_100), &[20]),
            [
                Duration::from_secs(5),
                Duration::from_secs(5),
                Duration::from_millis(100),
            ]
        );
    }

    #[test]
    fn stops_when_the_wall_clock_lands_exactly_on_the_deadline() {
        // 1 回目の眠りの間に壁時計が 20 秒進み、2 回目の眠りの後にちょうど期限に着く。
        assert_eq!(
            run_sleep_until_wall_clock(Duration::from_secs(30), &[20]),
            [Duration::from_secs(5), Duration::from_secs(5)]
        );
    }

    #[test]
    fn a_wall_clock_set_back_does_not_sleep_longer_than_the_duration() {
        // 壁時計が戻っても、眠りの合計は元の待ち時間を越えない（変更前より遅れない）。
        let slept = run_sleep_until_wall_clock(Duration::from_millis(12_100), &[-600]);

        assert_eq!(
            slept.iter().sum::<Duration>(),
            Duration::from_millis(12_100)
        );
    }

    #[test]
    fn a_zero_duration_does_not_sleep() {
        assert!(run_sleep_until_wall_clock(Duration::ZERO, &[]).is_empty());
    }

    // --- run_minute_ticker (AC-S3-11) ------------------------------------------

    #[test]
    fn ticker_emits_once_per_finished_wait() {
        let waits_left = Cell::new(3);
        let emitted = Cell::new(0);

        run_minute_ticker(
            || at(1_700_000_040, 0),
            |_| {
                if waits_left.get() == 0 {
                    ControlFlow::Break(())
                } else {
                    waits_left.set(waits_left.get() - 1);
                    ControlFlow::Continue(())
                }
            },
            || emitted.set(emitted.get() + 1),
        );

        assert_eq!(emitted.get(), 3);
    }

    #[test]
    fn ticker_does_not_emit_before_the_first_wait_finishes() {
        let emitted = Cell::new(0);

        run_minute_ticker(
            || at(1_700_000_040, 0),
            |_| ControlFlow::Break(()),
            || emitted.set(emitted.get() + 1),
        );

        assert_eq!(emitted.get(), 0);
    }

    #[test]
    fn ticker_recomputes_each_wait_from_the_current_time() {
        // 2 回目の待ちの前に時計が進んでいれば、その時刻から次の境界までを待つ
        // （固定の 60 秒を積み上げない）。
        let times = RefCell::new(vec![at(1_700_000_040, 0), at(1_700_000_100, 250_000_000)]);
        let waits = RefCell::new(Vec::new());

        run_minute_ticker(
            || times.borrow_mut().remove(0),
            |duration| {
                waits.borrow_mut().push(duration);
                if waits.borrow().len() == 2 {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            },
            || {},
        );

        assert_eq!(
            *waits.borrow(),
            [Duration::from_secs(60), Duration::from_millis(59_750)]
        );
    }
}
