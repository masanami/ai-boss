//! ai-boss 製品版の Tauri 2（macOS）の器（機能仕様
//! `docs/features/tauri-in-app-runtime.md` クリティカル設計決定・S2 の器の設計）。
//!
//! この crate は WebView 内の TS コア（`server/src/core-app.ts`）を Hono の
//! ルートごと動かすための「器」に徹する — LLM・通知・スケジューラはまだ
//! 配線しない（S3・#581 の範囲）。DB は #580 S2 で配線した: plugin-sql の
//! リポジトリ内 fork（`native/tauri-plugin-sql/`。接続 1 本・ATTACH 不可）を
//! 登録し、`tauri.conf.json` の `plugins.sql.preload` の DB を起動時に開く。
//! capability は `capabilities/default.json` の 1 件だけで、`main` のウィンドウに
//! `sql:allow-execute`・`sql:allow-select` を許可する（`load`・`close` は許可
//! しない。機能仕様 `docs/features/async-db-layer.md`「S2 の設計」）。
//! 証跡ファイルは #579 S4 で配線した: plugin-fs を登録し、capability で
//! `read_file`・`write_file`・`remove`・`exists` の 4 つだけを、保存先
//! （`app_config_dir` の直下の `evidence/`。[`prepare_evidence_dir`] が起動時に
//! 作る）の直下のファイルに限って許可する（機能仕様
//! `docs/features/tauri-in-app-runtime.md`「S4 の設計」）。
//!
//! メインウィンドウのナビゲーション・新規ウィンドウ・ダウンロードの許可判定は、
//! [`is_allowed_navigation`]・[`is_allowed_new_window`] という URL を受け取る
//! 純粋関数として切り出し、`cargo test` で固定する（Tauri の
//! `WebviewWindowBuilder::on_navigation`/`on_new_window` へはそのままクロージャ
//! として渡すだけで、判定ロジック自体はテスト対象として独立している）。

use std::io;
use std::path::{Path, PathBuf};

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

/// 証跡ファイルの保存先のディレクトリ名（`app_config_dir` の直下。
/// capability の fs のスコープ `$APPCONFIG/evidence/*` と web の実装の `evidence/`
/// と一致していることは、定数の共有ではなくテスト〔AC-S4-1・AC-S4-6・AC-S4-25〕が
/// 確かめる。機能仕様 `docs/features/tauri-in-app-runtime.md`「S4 の設計」・仮定 A11）。
const EVIDENCE_DIR_NAME: &str = "evidence";

/// 証跡ファイルの保存先（`<app_config_dir>/evidence`）を用意し、そのパスを返す
/// （機能仕様 S4「保存先」）。WebView には `mkdir` を許可しないため、ここ
/// （起動時の `setup`）で作る。
///
/// 既にあって**実ディレクトリでない**（シンボリックリンク・通常のファイル）
/// ときは失敗させ、器を起動しない。plugin-fs のスコープの判定は、まだ無い
/// パスを `canonicalize` しないため、保存先そのものがアプリの外を指す
/// シンボリックリンクだと、新しいファイルの書き込みがリンク先（アプリの外）に
/// 届いてしまう——その経路を塞ぐ（`symlink_metadata` はリンクを辿らない）。
pub fn prepare_evidence_dir(app_config_dir: &Path) -> io::Result<PathBuf> {
    let dir = app_config_dir.join(EVIDENCE_DIR_NAME);
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.is_dir() => Ok(dir),
        Ok(_) => Err(io::Error::other(format!(
            "the evidence directory is not a real directory (a symlink or a file): {}",
            dir.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&dir)?;
            Ok(dir)
        }
        Err(error) => Err(error),
    }
}

/// メインウィンドウのナビゲーション先として許すかどうかを判定する（機能仕様
/// S2「権限と到達経路の境界」・受入基準）。
///
/// アプリのオリジン（`tauri://localhost`）だけを許し、それ以外（外部の
/// `https:`/`http:`、`file:`、`blob:`、`data:` 等）はすべて拒否する。
/// `tauri://` スキームでも `localhost` 以外のホスト（例:
/// `tauri://evil.example`）は許さない — オリジン全体（scheme + host）が
/// 一致することを要求する。
pub fn is_allowed_navigation(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

/// `blob:` の接頭辞（アプリのオリジン配下）。新規ウィンドウの許可判定
/// ([`is_allowed_new_window`]) だけが使う — ナビゲーション判定
/// ([`is_allowed_navigation`]) は `blob:` を常に拒否するため対象外。
const ALLOWED_BLOB_URL_PREFIX: &str = "tauri://localhost/";

/// 新規ウィンドウ（`window.open`）の要求先として許すかどうかを判定する（機能
/// 仕様 S2「権限と到達経路の境界」・受入基準）。
///
/// アプリのオリジンの `blob:` URL（証跡ファイルの表示。例:
/// `blob:tauri://localhost/<uuid>`）だけを許し、それ以外（外部オリジンの
/// `blob:`、`https:`/`http:`、`file:`、`data:`、`about:blank` 等）はすべて
/// 拒否する。
///
/// `url` クレートは `blob:` を "cannot-be-a-base" スキームとして扱い、
/// `scheme()` は `"blob"`、`path()` はコロンの後ろ全体（例:
/// `"tauri://localhost/<uuid>"`）になる（2026-09-28 に実測で確認）。
/// `starts_with` で末尾の `/` まで含めて比較することで、
/// `tauri://localhost.evil.example/...` のような接頭辞だけが似た文字列を
/// 誤って許可しない。
pub fn is_allowed_new_window(url: &Url) -> bool {
    url.scheme() == "blob" && url.path().starts_with(ALLOWED_BLOB_URL_PREFIX)
}

/// メインウィンドウを組み立てる（`tauri.conf.json` の `app.windows` ではなく
/// `setup` の中で `WebviewWindowBuilder` を使う。機能仕様 S2「器の構成」）。
/// ナビゲーション・新規ウィンドウ・ダウンロードの許可判定をここで登録する。
fn build_main_window<R: Runtime, M: tauri::Manager<R>>(
    manager: &M,
) -> tauri::Result<tauri::WebviewWindow<R>> {
    // self-review（code-reviewer・design-reviewer 双方が独立に CONFIRMED）:
    // 製品版の web のビルド（`vite.app.config.ts`）の出力は `app.html`
    // （`web/dist-app/app.html`）で `index.html` は存在しない。ここを
    // `"index.html"` のままにすると Tauri のアセット解決
    // （`index.html` → `index.html.html` → `index.html/index.html` →
    // `index.html` の順に試し、最後まで見つからず `AssetNotFound`）が失敗し、
    // ウィンドウは開いても中身が表示されない（手動の確認手順でしか発覚しない
    // 欠陥だった）。
    WebviewWindowBuilder::new(manager, "main", WebviewUrl::App("app.html".into()))
        .title("ai-boss")
        .on_navigation(is_allowed_navigation)
        // self-review（code-reviewer、PLAUSIBLE）: `NewWindowResponse::Allow`
        // は wry の既定実装に任せる形で、生成される新規ウィンドウ（証跡の
        // `blob:` を表示する）には `on_navigation`/`on_new_window`/
        // `on_download` が登録されない（wry 0.55 のソースで確認: Allow 分岐は
        // メインウィンドウと同じ WKWebViewConfiguration を渡して WKWebView を
        // 作るだけで、delegate は設定しない）。`NewWindowResponse::Create` で
        // 明示的に組み立て直せば同じ判定を登録できるが、`Create` は
        // macOS では呼び出し元と同じ `WebviewConfiguration`
        // （`NewWindowFeatures::webview_configuration`）を明示的に渡さない限り
        // 別の webview 実体になり、`blob:` URL（呼び出し元の webview の
        // blob URL ストアにだけ存在する）を解決できない恐れがある——手動でしか
        // 確認できない領域（機能仕様 S2「権限と到達経路の境界」の
        // 「`blob:` の新しいウィンドウが実機で本文を表示できるかは…未検証の
        // リスクとして残す」）に踏み込むため、確証の無いまま書き換えると
        // 証跡表示そのものを壊す恐れがある。そのため S2 では `Allow` のまま
        // とし、**この新規ウィンドウ自身の中でのさらなるナビゲーション
        // （例: 証跡ファイル内のリンク）が制限を受けないことは、既知の
        // 未検証リスクとして残す**（対象は証跡ファイルを開いた先の別ウィンドウ
        // に限られ、メインウィンドウの `on_navigation` 制限は影響を受けない）。
        .on_new_window(|url, _features: NewWindowFeatures| {
            if is_allowed_new_window(&url) {
                NewWindowResponse::Allow
            } else {
                NewWindowResponse::Deny
            }
        })
        // ダウンロードの要求はすべて拒否する（機能仕様「やらないこと」S2 追加分・
        // 「権限と到達経路の境界」）。
        .on_download(|_webview, _event| false)
        .build()
}

/// アプリのエントリポイント（`main.rs` の `app_lib::run()`）。
pub fn run() {
    configure(tauri::Builder::default())
        .run(context())
        .expect("error while running tauri application");
}

/// `tauri.conf.json`・capability（ACL）・アセットを埋め込んだコンテキスト。
/// 結合テストと IPC の中継も製品版と同じものを使えるよう、ここで 1 度だけ
/// 生成する（`generate_context!` を別のターゲットでも展開すると、埋め込みの
/// Info.plist のシンボルがリンク時に重複する）。
pub fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// 器の組み立て（プラグインの登録とメインウィンドウ）。`run` と、MockRuntime
/// の上で同じ器を組む結合テスト（`tests/sql_plugin.rs`）・IPC の中継
/// （`examples/sql-ipc-bridge.rs`）が共有する（#580 S2。機能仕様
/// docs/features/async-db-layer.md「契約テストを器の上で通す仕組み」）。
///
/// plugin-sql（リポジトリ内 fork。接続 1 本）は `tauri.conf.json` の
/// `plugins.sql.preload` の DB を起動時に開く。WebView には `load` を許可
/// しない（`capabilities/default.json`）。
///
/// plugin-fs（#579 S4）は、証跡ファイルの保存先（[`prepare_evidence_dir`]）の
/// 直下だけを capability のスコープで許可する。
pub fn configure<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            prepare_evidence_dir(&app.path().app_config_dir()?)?;
            build_main_window(app)?;
            Ok(())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap_or_else(|e| panic!("failed to parse test URL {s:?}: {e}"))
    }

    // --- prepare_evidence_dir（#579 S4: AC-S4-1〜3 の関数の単体） -------------

    #[test]
    fn prepare_evidence_dir_creates_evidence_under_a_config_dir_that_does_not_exist_yet() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("dev.aiboss.app");

        let dir = prepare_evidence_dir(&config_dir).unwrap();

        assert_eq!(dir, config_dir.join("evidence"));
        assert!(std::fs::symlink_metadata(&dir).unwrap().is_dir());
    }

    #[test]
    fn prepare_evidence_dir_keeps_an_existing_real_directory_and_its_files() {
        let config_dir = tempfile::tempdir().unwrap();
        let evidence = config_dir.path().join("evidence");
        std::fs::create_dir(&evidence).unwrap();
        std::fs::write(evidence.join("kept.png"), b"kept").unwrap();

        // 2 回目の起動でも成功し、既存のファイルに触れない。
        assert_eq!(prepare_evidence_dir(config_dir.path()).unwrap(), evidence);
        assert_eq!(prepare_evidence_dir(config_dir.path()).unwrap(), evidence);

        assert_eq!(std::fs::read(evidence.join("kept.png")).unwrap(), b"kept");
    }

    #[test]
    fn prepare_evidence_dir_rejects_a_regular_file() {
        let config_dir = tempfile::tempdir().unwrap();
        std::fs::write(config_dir.path().join("evidence"), b"not a directory").unwrap();

        assert!(prepare_evidence_dir(config_dir.path()).is_err());
        // 通常のファイルは置き換えない。
        assert_eq!(
            std::fs::read(config_dir.path().join("evidence")).unwrap(),
            b"not a directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn prepare_evidence_dir_rejects_a_symlink_to_a_directory_outside_the_config_dir() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("config");
        let outside = root.path().join("outside");
        std::fs::create_dir(&config_dir).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, config_dir.join("evidence")).unwrap();

        assert!(prepare_evidence_dir(&config_dir).is_err());
        // リンクはそのまま（消さない・張り替えない）で、リンク先には何も作らない。
        assert_eq!(std::fs::read_link(config_dir.join("evidence")).unwrap(), outside);
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_evidence_dir_rejects_a_symlink_to_a_directory_inside_the_config_dir() {
        let config_dir = tempfile::tempdir().unwrap();
        let elsewhere = config_dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, config_dir.path().join("evidence")).unwrap();

        assert!(prepare_evidence_dir(config_dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn prepare_evidence_dir_rejects_a_dangling_symlink() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("config");
        std::fs::create_dir(&config_dir).unwrap();
        let missing = root.path().join("missing");
        std::os::unix::fs::symlink(&missing, config_dir.join("evidence")).unwrap();

        assert!(prepare_evidence_dir(&config_dir).is_err());
        // リンク切れの先を作らない（`create_dir_all` がリンクを辿ると作ってしまう）。
        assert!(!missing.exists());
    }

    // --- is_allowed_navigation ------------------------------------------------

    #[test]
    fn navigation_allows_the_app_origin() {
        assert!(is_allowed_navigation(&url("tauri://localhost")));
    }

    #[test]
    fn navigation_denies_external_https() {
        assert!(!is_allowed_navigation(&url("https://example.com/")));
    }

    #[test]
    fn navigation_denies_dev_server_localhost() {
        assert!(!is_allowed_navigation(&url("http://localhost:8787/")));
    }

    #[test]
    fn navigation_denies_file_scheme() {
        assert!(!is_allowed_navigation(&url("file:///etc/hosts")));
    }

    #[test]
    fn navigation_denies_own_origin_blob_url() {
        assert!(!is_allowed_navigation(&url(
            "blob:tauri://localhost/9f3e1b0a-1111-2222-3333-444455556666"
        )));
    }

    #[test]
    fn navigation_denies_data_scheme() {
        assert!(!is_allowed_navigation(&url("data:text/html,x")));
    }

    #[test]
    fn navigation_denies_spoofed_host_with_tauri_scheme() {
        // scheme が一致するだけでは足りない（host も一致すること）を境界値で固定する。
        assert!(!is_allowed_navigation(&url("tauri://evil.example")));
    }

    // --- is_allowed_new_window -------------------------------------------------

    #[test]
    fn new_window_allows_own_origin_blob_url() {
        assert!(is_allowed_new_window(&url(
            "blob:tauri://localhost/9f3e1b0a-1111-2222-3333-444455556666"
        )));
    }

    #[test]
    fn new_window_denies_external_https() {
        assert!(!is_allowed_new_window(&url("https://example.com/")));
    }

    #[test]
    fn new_window_denies_dev_server_localhost() {
        assert!(!is_allowed_new_window(&url("http://localhost:8787/")));
    }

    #[test]
    fn new_window_denies_file_scheme() {
        assert!(!is_allowed_new_window(&url("file:///etc/hosts")));
    }

    #[test]
    fn new_window_denies_foreign_origin_blob_url() {
        assert!(!is_allowed_new_window(&url(
            "blob:https://example.com/9f3e1b0a-1111-2222-3333-444455556666"
        )));
    }

    #[test]
    fn new_window_denies_data_scheme() {
        assert!(!is_allowed_new_window(&url("data:text/html,x")));
    }

    #[test]
    fn new_window_denies_about_blank() {
        assert!(!is_allowed_new_window(&url("about:blank")));
    }

    #[test]
    fn new_window_denies_prefix_spoof_without_trailing_slash() {
        // "tauri://localhost" に続く文字が "/" でない偽装（例:
        // "tauri://localhost.evil.example/...")を、接頭辞の緩い一致で
        // 誤って許可しないことを固定する。
        assert!(!is_allowed_new_window(&url(
            "blob:tauri://localhost.evil.example/9f3e1b0a-1111-2222-3333-444455556666"
        )));
    }
}
