//! #681 の結合テスト（機能仕様 docs/features/ios-shell.md 仮定 A12）。
//!
//! iOS でアプリのデータ（`app_config_dir`）を OS のバックアップから外す処理が、
//! plugin-sql の初期化（`tauri.conf.json` の `plugins.sql.preload` が DB を作って開く）
//! **より前**に走ること、外せなければ DB を作らずに器の組み立てが失敗すること
//! （fail-closed）を、器（`app_lib::configure_with_backup_exclusion`）を `MockRuntime`
//! の上に製品版と同じ `tauri.conf.json` で組んで確かめる。ホスト（macOS）の製品の経路は
//! 除外しないため、除外の処理は記録する模擬・失敗する模擬を注入する（iOS で実際に
//! 属性が付くことはシミュレータで観測する。PR #682）。
//!
//! 利用者のアプリのデータディレクトリに触れないよう、テストのプロセスの
//! `HOME` を一時ディレクトリへ向け、テストごとに別の identifier（＝別の
//! データディレクトリ）で器を組む。

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use app_lib::{SecureState, APP_DATA_BACKUP_EXCLUSION_PLUGIN_NAME};
use secure_transport::{DestinationTable, MemoryKeyStore};
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Manager};

/// 製品版の DB のファイル名（`tauri.conf.json` の `plugins.sql.preload` の `sqlite:ai-boss.db`）。
const DB_FILE: &str = "ai-boss.db";

/// テストのプロセスの `HOME`（`sql_plugin.rs` と同じ仕組み。ファイルごとに別の
/// ディレクトリ）。
fn test_home() -> &'static Path {
    static HOME: OnceLock<PathBuf> = OnceLock::new();
    HOME.get_or_init(|| {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("backup-exclusion-home");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("failed to create the test HOME");
        std::env::set_var("HOME", &dir);
        dir
    })
}

/// 除外が呼ばれた時点の観測（付け先と、そのとき DB・証跡の保存先が既にあったか）。
#[derive(Debug, PartialEq)]
struct Observed {
    path: PathBuf,
    db_existed: bool,
    evidence_existed: bool,
}

static OBSERVED: Mutex<Vec<Observed>> = Mutex::new(Vec::new());

fn observe_exclusion(path: &Path) -> io::Result<()> {
    OBSERVED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(Observed {
            path: path.to_path_buf(),
            db_existed: path.join(DB_FILE).exists(),
            evidence_existed: path.join("evidence").exists(),
        });
    Ok(())
}

fn fail_exclusion(_path: &Path) -> io::Result<()> {
    Err(io::Error::other("exclusion failed"))
}

fn observed_for(config_dir: &Path) -> Vec<Observed> {
    let mut observed = OBSERVED.lock().unwrap_or_else(|e| e.into_inner());
    let (mine, others) = observed.drain(..).partition(|o| o.path == config_dir);
    *observed = others;
    mine
}

/// 器を組む（`setup` はまだ走っていない）。`label` ごとに identifier を変える。
fn build(
    label: &str,
    exclusion: app_lib::BackupExclusion,
) -> (PathBuf, tauri::Result<App<MockRuntime>>) {
    test_home();
    let mut context = app_lib::context();
    context.config_mut().identifier = format!("dev.aiboss.app.test-backup-{label}");
    let config_dir = PathBuf::from(std::env::var("HOME").unwrap())
        .join("Library/Application Support")
        .join(&context.config().identifier);
    let state = SecureState::new(
        DestinationTable::from_entries::<&str>([]),
        Arc::new(MemoryKeyStore::new()),
    )
    .unwrap();
    let app = app_lib::configure_with_backup_exclusion(mock_builder(), state, Some(exclusion))
        .build(context);
    (config_dir, app)
}

#[test]
fn the_exclusion_runs_on_the_app_config_dir_before_the_sql_preload_creates_the_db() {
    let (config_dir, app) = build("order", observe_exclusion);
    let mut app = app.expect("failed to build the app on MockRuntime");
    assert_eq!(app.path().app_config_dir().unwrap(), config_dir);

    // 除外は組み立て（プラグインの初期化）の中で、DB の preload・アプリの `setup`
    // （証跡の保存先を作る）より前に、`app_config_dir` そのものへ 1 回だけ走る。
    assert_eq!(
        observed_for(&config_dir),
        vec![Observed {
            path: config_dir.clone(),
            db_existed: false,
            evidence_existed: false
        }]
    );
    // その後で plugin-sql の preload が DB を作っている（除外したディレクトリの配下）。
    assert!(config_dir.join(DB_FILE).is_file());

    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    assert!(app.get_webview_window("main").is_some());
    assert!(config_dir.join("evidence").is_dir());
    // `setup` で 2 回目の除外は走らない。
    assert!(observed_for(&config_dir).is_empty());
}

#[test]
fn a_failed_exclusion_stops_the_build_before_the_db_is_created() {
    let (config_dir, app) = build("fail", fail_exclusion);

    match app {
        Err(tauri::Error::PluginInitialization(name, message)) => {
            assert_eq!(name, APP_DATA_BACKUP_EXCLUSION_PLUGIN_NAME);
            assert_eq!(message, "exclusion failed");
        }
        Err(other) => panic!("unexpected error: {other}"),
        Ok(_) => panic!("the build should fail when the exclusion fails"),
    }
    // DB は作られていない（バックアップの対象のまま DB を開かない）。
    assert!(!config_dir.join(DB_FILE).exists());
}
