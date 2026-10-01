//! ai-boss 製品版の Tauri 2（macOS）の器（機能仕様
//! `docs/features/tauri-in-app-runtime.md` クリティカル設計決定・S2 の器の設計）。
//!
//! この crate は WebView 内の TS コア（`server/src/core-app.ts`）を Hono の
//! ルートごと動かすための「器」に徹する。
//! 通知・毎分の刻み・メニューバー常駐は #579 S3 で足した（[`desktop_shell`]）。
//! LLM の送信は #581 S3 で配線した: 秘密情報を扱う通信層
//! （`native/secure-transport/`）をコマンド 5 つ（[`APP_COMMANDS`]・
//! [`secure_commands`]）で公開する。キーの値を返すコマンドは無い。DB は #580 S2 で配線した: plugin-sql の
//! リポジトリ内 fork（`native/tauri-plugin-sql/`。接続 1 本・ATTACH 不可）を
//! 登録し、`tauri.conf.json` の `plugins.sql.preload` の DB を起動時に開く。
//! capability は 2 件ある。`platforms` を指定しない `capabilities/default.json` は
//! `main` のウィンドウに
//! `sql:allow-execute`・`sql:allow-select`（`load`・`close` は許可しない。機能
//! 仕様 `docs/features/async-db-layer.md`「S2 の設計」）と、通信層の 5 つの
//! コマンドの `allow-*` を許可する（#581 S3）。
//! 証跡ファイルは #579 S4 で配線した: plugin-fs を登録し、capability で
//! `read_file`・`write_file`・`remove`・`exists` の 4 つだけを、保存先
//! （`app_config_dir` の直下の `evidence/`。[`prepare_evidence_dir`] が起動時に
//! 作る）の直下のファイルに限って許可する（機能仕様
//! `docs/features/tauri-in-app-runtime.md`「S4 の設計」）。
//! #579 S3 の `notification:allow-notify`・`core:event:allow-listen` も許可する。
//! もう 1 件の `capabilities/mobile-nudges.json` は `platforms` を iOS・Android に
//! 限り、予約通知の `notification:allow-cancel`・`notification:allow-get-pending`
//! だけを許可する（#585 S3・機能仕様 `docs/features/scheduled-nudges.md`）。
//!
//! メインウィンドウのナビゲーション・新規ウィンドウ・ダウンロードの許可判定は、
//! [`is_allowed_navigation`]・[`is_allowed_new_window`] という URL を受け取る
//! 純粋関数として切り出し、`cargo test` で固定する（Tauri の
//! `WebviewWindowBuilder::on_navigation`/`on_new_window` へはそのままクロージャ
//! として渡すだけで、判定ロジック自体はテスト対象として独立している）。

use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::time::Duration;

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{Manager, Runtime, Url, WebviewWindowBuilder};

pub mod desktop_shell;

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

/// 多重起動の排他の錠のファイル名（`app_config_dir` の直下。DB と同じ場所）。
const INSTANCE_LOCK_FILE_NAME: &str = "ai-boss.lock";

/// 多重起動の排他の錠を取るプラグインの名前（#659）。錠を取れないとき、器の
/// 組み立ては `tauri::Error::PluginInitialization` にこの名前を載せて失敗する。
pub const INSTANCE_LOCK_PLUGIN_NAME: &str = "instance-lock";

/// 錠を別の持ち手が持っている（[`acquire_instance_lock`] が `Ok(None)`）ときに、
/// 錠のプラグインが初期化の失敗に載せる文言。錠の取得そのものの失敗（データ
/// ディレクトリを作れない・ファイルを開けない等）と見分けるために固定する
/// （[`is_instance_lock_held`]）。
pub const INSTANCE_LOCK_HELD_MESSAGE: &str = "another instance of the app holds the instance lock";

/// 器の組み立ての失敗が「錠を別の持ち手が持っている」ことによるものか（#664）。
/// 錠のプラグインの失敗で、かつ文言が [`INSTANCE_LOCK_HELD_MESSAGE`] のときだけ
/// `true`。データディレクトリの解決・作成・錠のファイルの I/O の失敗は `false`
/// （`run` はそれを無言で終えず、失敗として扱う）。
pub fn is_instance_lock_held(error: &tauri::Error) -> bool {
    matches!(
        error,
        tauri::Error::PluginInitialization(name, message)
            if name == INSTANCE_LOCK_PLUGIN_NAME && message == INSTANCE_LOCK_HELD_MESSAGE
    )
}

/// 多重起動の排他の錠（#659）。持っているあいだ（プロセスが生きているあいだ）、
/// 同じアプリのデータディレクトリに対する別の取得は失敗する。プロセスが落ちると
/// OS が外す（`flock`）。
pub struct InstanceLock {
    _file: std::fs::File,
}

/// 多重起動の排他の錠（`<app_config_dir>/ai-boss.lock` への排他の `flock`・
/// 非ブロッキング）を取る。別のプロセス（または同じプロセスの別の取得）が持って
/// いれば `Ok(None)`。
///
/// `tauri-plugin-single-instance` の待ち受けは非同期に始まるため、ほぼ同時の 2 つの
/// 起動がどちらも「先に起動したものは無い」と判定して続行しうる。錠の取得は原子的
/// なので、そのうち 1 つだけが DB・刻みへ進む。
pub fn acquire_instance_lock(app_config_dir: &Path) -> io::Result<Option<InstanceLock>> {
    std::fs::create_dir_all(app_config_dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(app_config_dir.join(INSTANCE_LOCK_FILE_NAME))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(InstanceLock { _file: file })),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

/// 多重起動の排他の錠を取るプラグイン。錠は `manage` して器が生きているあいだ持つ。
/// 取れなければ初期化を失敗させ、後に登録したプラグイン（single-instance の
/// ソケットの掃除・待ち受け、plugin-sql の DB の preload）と `setup`（刻みの送り手の
/// 起動）へ進ませない。別の持ち手が持っているときの失敗の文言は
/// [`INSTANCE_LOCK_HELD_MESSAGE`]。
fn instance_lock_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new(INSTANCE_LOCK_PLUGIN_NAME)
        .setup(|app, _api| match acquire_instance_lock(&app.path().app_config_dir()?)? {
            Some(lock) => {
                app.manage(lock);
                Ok(())
            }
            None => Err(INSTANCE_LOCK_HELD_MESSAGE.into()),
        })
        .build()
}

/// single-instance（`tauri-plugin-single-instance` 2.5 の macOS の実装。`semver`
/// 機能は無効）が 2 つ目の起動を受ける Unix ソケットのパス。プラグインと同じ式
/// （identifier の `.`・`-` を `_` にして `/tmp/<identifier>_si.sock`）。
#[cfg(target_os = "macos")]
pub fn single_instance_socket_path(identifier: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_")))
}

/// 錠を取れなかったプロセスが、既にあるプロセス（錠を持っている側）へ 2 つ目の起動を
/// 知らせる既定の試行の回数と間隔（[`notify_running_instance`]）。勝者の待ち受けは
/// 非同期に始まるため、ほぼ同時の起動でも数百 ms 以内に開く。
#[cfg(target_os = "macos")]
const NOTIFY_ATTEMPTS: u32 = 20;
#[cfg(target_os = "macos")]
const NOTIFY_INTERVAL: Duration = Duration::from_millis(100);

/// 既にあるプロセスの single-instance のソケットへ、2 つ目の起動の知らせ
/// （プラグインの `notify_singleton` と同じ形式: 作業ディレクトリ + `\0\0` + 引数を
/// `\0` で連結）を送る。
///
/// ソケットが無い（`NotFound`）・待ち受けが無い（`ConnectionRefused`）ときだけ、
/// `interval` を空けて `attempts` 回まで試す（錠を持つ勝者の待ち受けの開始が、
/// まだ済んでいないだけの可能性があるため）。それ以外のエラーは待たずに返す。
#[cfg(target_os = "macos")]
pub fn notify_running_instance(socket: &Path, attempts: u32, interval: Duration) -> io::Result<()> {
    let attempts = attempts.max(1);
    let mut attempt = 1;
    loop {
        match notify_once(socket) {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt < attempts
                    && matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                    ) =>
            {
                attempt += 1;
                std::thread::sleep(interval);
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "macos")]
fn notify_once(socket: &Path) -> io::Result<()> {
    use std::io::Write;

    let stream = std::os::unix::net::UnixStream::connect(socket)?;
    let mut writer = io::BufWriter::new(&stream);
    let cwd = std::env::current_dir().unwrap_or_default();
    writer.write_all(cwd.to_str().unwrap_or_default().as_bytes())?;
    writer.write_all(b"\0\0")?;
    writer.write_all(std::env::args().collect::<Vec<String>>().join("\0").as_bytes())?;
    writer.flush()
}

mod app_commands;
pub mod secure_commands;

pub use app_commands::APP_COMMANDS;
pub use secure_commands::SecureState;

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
    //
    // #579 S3（仮定 S3-A4）: 設定値（`background_throttling: Disabled`・`app.html`）を
    // テストで検査できるよう、`WebviewWindowBuilder::new` ではなくコードで組んだ
    // `WindowConfig` から作る（`desktop_shell::main_window_config`）。
    WebviewWindowBuilder::from_config(manager, &desktop_shell::main_window_config())?
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
///
/// #579 S3: メニューバーのアイコンは `RunEvent::Ready` で作り、閉じる要求（メインの
/// ウィンドウは隠す）・Dock の再表示の要求もここで処理する
/// （`desktop_shell::handle_run_event`）。`configure` では作らない。
pub fn run() {
    let context = context();
    #[cfg(target_os = "macos")]
    let socket = single_instance_socket_path(&context.config().identifier);
    let app = match configure(with_single_instance(tauri::Builder::default())).build(context) {
        Ok(app) => app,
        // ほぼ同時に起動した別のプロセスが錠を持っている（#659）: DB・刻みに触れずに終わる。
        // 錠を取れなかったプロセスは single-instance のプラグインを通らない（#664）ため、
        // 既にあるプロセスへの知らせ（前面化）は自分で行ってから終わる。
        Err(error) if is_instance_lock_held(&error) => {
            eprintln!("not starting: {error}");
            #[cfg(target_os = "macos")]
            if let Err(error) = notify_running_instance(&socket, NOTIFY_ATTEMPTS, NOTIFY_INTERVAL) {
                eprintln!("failed to notify the running instance: {error}");
            }
            return;
        }
        // 錠の取得そのものの失敗（データディレクトリ・錠のファイルの I/O）を含め、無言で終えない。
        Err(error) => panic!("error while building tauri application: {error}"),
    };
    app.run(|app, event| {
            if let tauri::RunEvent::Ready = event {
                if let Err(error) = desktop_shell::create_tray(app) {
                    eprintln!("failed to create the menu bar icon: {error}");
                }
            }
            desktop_shell::handle_run_event(app, event);
        });
}

/// 多重起動の防止（#659）を組み込む。`configure` より前（先頭の 2 つのプラグイン）に
/// 登録し、2 つ目の起動が DB の preload・刻みの送り手の起動より前に終わるようにする
/// （同じ DB に対して刻みが 2 重に走り、同じ催促を 2 回送らないように）。
///
/// 排他の錠（[`acquire_instance_lock`]）を取るプラグインを **single-instance より先**に
/// 登録する。プラグインの `setup` は登録順に走り、失敗したら以降は走らない。single-instance
/// は `setup` で既存のソケットへ接続を試み、つながらなければ**ソケットのファイルを消して**
/// 自分が待ち受ける——錠より後ろに置くと、ほぼ同時の 2 つの起動のうち錠を取れなかった
/// 方が、錠を取った勝者のソケットを消しうる（以降の起動は前面化の知らせが届かず、
/// 多重起動の防止が効かなくなる）。錠が先なら、錠を取れなかったプロセスは single-instance
/// の `setup`（掃除・待ち受け）を通らない。その代わり、錠を取れなかったふつうの 2 つ目の
/// 起動も single-instance の知らせを通らないため、`run` が
/// [`notify_running_instance`] で自分から既にあるプロセスへ知らせる（前面化を保つ。
/// 製品は macOS 限定で、この知らせも macOS の実装だけに置く）。
/// single-instance の待ち受けは非同期に始まるため、ほぼ同時の起動でも錠で原子的に
/// 1 つに絞る。
///
/// `configure` には入れない: `MockRuntime` の結合テストは 1 つのプロセスで器を
/// 何度も組むため、2 回目が 2 つ目の起動と判定されてテストのプロセスが終了する。
pub fn with_single_instance<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(instance_lock_plugin())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            desktop_shell::on_second_instance(app)
        }))
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
    let secure_state = SecureState::production().expect("failed to build the secure transport");
    configure_with(builder, secure_state)
}

/// [`configure`] の、秘密情報を扱う通信層の状態を注入できる形（#581 S3。
/// 機能仕様 docs/features/secure-transport-byok.md 仮定 A18）。製品版は
/// [`SecureState::production`]（製品版の宛先の表とキーチェーン）、テストは
/// 模擬の宛先の表とメモリの保管を渡す。
pub fn configure_with<R: Runtime>(builder: tauri::Builder<R>, secure_state: SecureState) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        // #579 S3: 通知の送信（`plugin:notification|notify`。WebView には
        // `notification:allow-notify` だけを許可する）。
        .plugin(tauri_plugin_notification::init())
        .manage(secure_state)
        // 公開するコマンドは `APP_COMMANDS` の 5 つだけ（`build.rs` が同じ一覧を
        // `AppManifest` に渡す。一覧との一致は tests/secure_commands.rs が IPC で
        // 確かめる）。キーの値を返すコマンドは無い。
        .invoke_handler(tauri::generate_handler![
            secure_commands::secure_send,
            secure_commands::secure_cancel,
            secure_commands::byok_key_set,
            secure_commands::byok_key_delete,
            secure_commands::byok_key_status,
        ])
        .setup(|app| {
            prepare_evidence_dir(&app.path().app_config_dir()?)?;
            build_main_window(app)?;
            // #579 S3: 毎分の刻みを WebView へ送る（ウィンドウを隠しても続く）。
            app.manage(desktop_shell::spawn_minute_ticker(app.handle().clone())?);
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

    // --- acquire_instance_lock（#659: 多重起動の原子的な排他） ------------------

    /// 子プロセスを起こすテストと、錠を手放して取り直すテストを直列にする。子を
    /// 起こす途中（fork から exec まで）の子は親の開いているファイルを一時的に
    /// 持つため、その間に手放した錠が外れず、取り直しが失敗しうる（並行に走らせて
    /// 1 回再現）。
    static LOCK_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_second_acquisition_of_the_instance_lock_fails_while_the_first_is_held() {
        let _serial = LOCK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let config_dir = tempfile::tempdir().unwrap();

        let first = acquire_instance_lock(config_dir.path()).unwrap();
        assert!(first.is_some(), "the first acquisition should get the lock");

        // 別に開いたファイルからの 2 回目の取得（2 つ目の起動と同じ）は取れない。
        assert!(acquire_instance_lock(config_dir.path()).unwrap().is_none());

        // 持ち手が手放せば取れる。
        drop(first);
        assert!(acquire_instance_lock(config_dir.path()).unwrap().is_some());
    }

    #[test]
    fn the_instance_lock_can_be_acquired_under_a_config_dir_that_does_not_exist_yet() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("dev.aiboss.app");

        assert!(acquire_instance_lock(&config_dir).unwrap().is_some());
    }

    /// 子プロセスとして起動されたときだけ、`INSTANCE_LOCK_HOLDER_DIR` の錠を取って
    /// 標準出力に `locked` と書き、殺されるまで持ち続ける（下のテストの持ち手）。
    #[test]
    #[ignore = "helper process for the_instance_lock_is_released_when_the_holder_process_dies"]
    fn instance_lock_holder_process() {
        let Some(dir) = std::env::var_os("INSTANCE_LOCK_HOLDER_DIR") else {
            return;
        };
        let _lock = acquire_instance_lock(Path::new(&dir))
            .unwrap()
            .expect("the holder should get the lock");
        println!("locked");
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }

    #[test]
    fn the_instance_lock_is_released_when_the_holder_process_dies() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let _serial = LOCK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let config_dir = tempfile::tempdir().unwrap();
        /// テストが途中で失敗しても、持ち手の子プロセスを残さない。
        struct KillOnDrop(std::process::Child);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let mut holder = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::instance_lock_holder_process", "--ignored", "--nocapture"])
            .env("INSTANCE_LOCK_HOLDER_DIR", config_dir.path())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(holder.stdout.take().unwrap());
        let holder = KillOnDrop(holder);
        let mut line = String::new();
        while line.trim() != "locked" {
            line.clear();
            if stdout.read_line(&mut line).unwrap() == 0 {
                panic!("the holder process exited before taking the lock");
            }
        }

        let while_held = acquire_instance_lock(config_dir.path()).unwrap().is_none();
        drop(holder);

        assert!(while_held, "the lock held by another process should not be acquired");
        assert!(
            acquire_instance_lock(config_dir.path()).unwrap().is_some(),
            "the lock should be released when the holder process dies"
        );
    }

    // --- is_instance_lock_held（#664: 錠が保持中の失敗だけを無言終了にする判定） ----

    #[test]
    fn a_held_instance_lock_error_from_the_lock_plugin_is_recognized() {
        let error = tauri::Error::PluginInitialization(
            INSTANCE_LOCK_PLUGIN_NAME.into(),
            INSTANCE_LOCK_HELD_MESSAGE.into(),
        );

        assert!(is_instance_lock_held(&error));
    }

    #[test]
    fn the_held_message_from_another_plugin_is_not_a_held_instance_lock() {
        let error = tauri::Error::PluginInitialization("sql".into(), INSTANCE_LOCK_HELD_MESSAGE.into());

        assert!(!is_instance_lock_held(&error));
    }

    #[test]
    fn another_failure_of_the_lock_plugin_is_not_a_held_instance_lock() {
        let error = tauri::Error::PluginInitialization(
            INSTANCE_LOCK_PLUGIN_NAME.into(),
            "Permission denied (os error 13)".into(),
        );

        assert!(!is_instance_lock_held(&error));
    }

    // --- single-instance のソケットへの知らせ（#664） -----------------------------

    #[cfg(target_os = "macos")]
    #[test]
    fn single_instance_socket_path_follows_the_plugin_rule() {
        assert_eq!(
            single_instance_socket_path("dev.aiboss.app"),
            PathBuf::from("/tmp/dev_aiboss_app_si.sock")
        );
        assert_eq!(
            single_instance_socket_path("dev.aiboss.app-test"),
            PathBuf::from("/tmp/dev_aiboss_app_test_si.sock")
        );
    }

    /// 一時ディレクトリの中のソケットのパス（Unix ソケットのパスは 104 バイト未満）。
    #[cfg(target_os = "macos")]
    fn short_socket_in(dir: &tempfile::TempDir) -> PathBuf {
        let socket = dir.path().join("si.sock");
        assert!(socket.as_os_str().len() < 104, "the test socket path is too long");
        socket
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notify_running_instance_retries_until_the_winner_binds_the_socket() {
        use std::io::Read;
        use std::os::unix::net::UnixListener;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let socket = short_socket_in(&dir);
        let (received_tx, received_rx) = std::sync::mpsc::channel::<String>();
        // 勝者の待ち受けは非同期に始まる: 知らせる側が最初に試した後で bind する。
        let listener_socket = socket.clone();
        let winner = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            let listener = UnixListener::bind(&listener_socket).unwrap();
            let (mut stream, _) = listener.accept().unwrap();
            let mut body = String::new();
            stream.read_to_string(&mut body).unwrap();
            received_tx.send(body).unwrap();
        });

        notify_running_instance(&socket, 50, Duration::from_millis(20)).unwrap();

        let body = received_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        winner.join().unwrap();
        // プラグインの知らせと同じ形式: 作業ディレクトリ + "\0\0" + 引数（"\0" 区切り）。
        let (cwd, args) = body.split_once("\0\0").expect("the body has the \\0\\0 separator");
        assert_eq!(cwd, std::env::current_dir().unwrap().to_str().unwrap());
        assert_eq!(args.split('\0').map(String::from).collect::<Vec<_>>(), std::env::args().collect::<Vec<_>>());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notify_running_instance_gives_up_after_the_attempts_when_there_is_no_socket() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().unwrap();
        let socket = short_socket_in(&dir);
        let started = Instant::now();

        let error = notify_running_instance(&socket, 3, Duration::from_millis(30)).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        // 試行の間（3 回なら 2 回）だけ待つ。
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notify_running_instance_also_retries_a_socket_nobody_listens_on() {
        use std::os::unix::net::UnixListener;
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().unwrap();
        let socket = short_socket_in(&dir);
        // 待ち受けを止めたソケットのファイルは残り、接続は拒否される。
        drop(UnixListener::bind(&socket).unwrap());
        let started = Instant::now();

        let error = notify_running_instance(&socket, 3, Duration::from_millis(30)).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::ConnectionRefused);
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notify_running_instance_returns_other_errors_without_retrying() {
        use std::time::{Duration, Instant};

        // Unix ソケットのパスが長すぎる（NotFound・ConnectionRefused 以外のエラー）。
        let socket = tempfile::tempdir().unwrap().path().join("x".repeat(200));
        let started = Instant::now();

        let error = notify_running_instance(&socket, 5, Duration::from_millis(500)).unwrap_err();

        assert!(!matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
        ));
        assert!(started.elapsed() < Duration::from_millis(500), "the error should not be retried");
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
