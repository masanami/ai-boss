//! 設定の検査テスト（機能仕様 `docs/features/tauri-in-app-runtime.md` 受入基準
//! （S2）「Tauri の器の権限と到達経路（Rust のテスト・設定の検査）」）。
//!
//! `tauri.conf.json`・`capabilities/`・`Cargo.toml` を実ファイルとして読み、
//! 受入基準の各項目を個別に検査する（`cargo test` の一部として実行される
//! ため、Tauri の実行環境やビルド済みバイナリは不要）。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load_tauri_conf() -> serde_json::Value {
    let path = manifest_dir().join("tauri.conf.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {} as JSON: {e}", path.display()))
}

fn load_cargo_toml() -> toml::Value {
    let path = manifest_dir().join("Cargo.toml");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    toml::from_str(&text)
        .unwrap_or_else(|e| panic!("failed to parse {} as TOML: {e}", path.display()))
}

/// CSP のディレクティブを、`tauri.conf.json` の `app.security.csp` オブジェクト
/// （ディレクティブ名 → ソースの配列）から1本取り出す。オブジェクト形式でない
/// （文字列1本・未設定・null）場合は空とみなす — その場合、各テストの
/// アサーションが失敗する形になる（例: `default-src` が空なら `'self'` だけ
/// という等値比較に失敗する）。
fn csp_directive(conf: &serde_json::Value, directive: &str) -> Vec<String> {
    conf["app"]["security"]["csp"]
        .get(directive)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// capabilities/
// ---------------------------------------------------------------------------

#[test]
fn capabilities_grant_only_the_four_minimal_permissions_to_the_main_window() {
    // #580 S2（docs/features/async-db-layer.md AC-S2-5）: #579 S2 の「0 件」を、
    // DB に要る最小の単位（`sql:allow-execute`・`sql:allow-select`）へ置き
    // 換えた。`load`（任意のパスの DB を開ける）・`close`・`sql:default` は
    // 許可しない。
    //
    // #579 S3（機能仕様 docs/features/tauri-in-app-runtime.md AC-S3-14）: さらに
    // 通知の送信（`notification:allow-notify`）と刻みのイベントの購読
    // （`core:event:allow-listen`）を足した 4 件だけ。`notification:default`・
    // 許可の問い合わせ・`core:event:allow-emit` 等は足さない。
    //
    // 「By default (not set or empty list), all capability files from
    // ./capabilities/ are included」（tauri-utils の SecurityConfig::capabilities
    // のドキュメント）— したがって、ディレクトリ配下のファイルの全件を検査
    // すれば足りる（`app.security.capabilities` で個別指定して絞る形は使って
    // いない。インラインの経路は下の別テストが塞ぐ）。
    //
    // self-review（code-reviewer, CONFIRMED）: tauri-build（`acl.rs`）は
    // `./capabilities/**/*`（サブディレクトリを含めて再帰的）を対象にし、
    // JSON5（`.json5` 拡張子や、コメント付き `.json`）もパースする。以前は
    // トップレベルの `.json`/`.toml` だけを見ていたため、サブディレクトリへ
    // 置かれたファイルや `.json5` 拡張子のファイルが検査を素通りしていた。
    let dir = manifest_dir().join("capabilities");
    let entries = find_capability_files_recursively(&dir);
    assert_eq!(
        entries,
        vec![dir.join("default.json")],
        "capabilities/ 配下（サブディレクトリ含む）の capability は default.json の 1 件だけであること"
    );
    let text = fs::read_to_string(&entries[0]).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(
        capability.get("webviews").is_none() && capability.get("remote").is_none(),
        "対象は main のウィンドウだけ（webviews・remote を指定しない）: {capability}"
    );
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "sql:allow-execute",
            "sql:allow-select",
            "notification:allow-notify",
            "core:event:allow-listen"
        ])
    );
}

// ---------------------------------------------------------------------------
// #580 S2: plugin-sql の fork と DB ファイル（docs/features/async-db-layer.md
// 受入基準（S2）AC-S2-1・AC-S2-3・AC-S2-4・AC-S2-7）
// ---------------------------------------------------------------------------

fn fork_dir() -> PathBuf {
    manifest_dir().join("../tauri-plugin-sql")
}

#[test]
fn fork_keeps_upstream_license_files() {
    for name in ["LICENSE_MIT", "LICENSE_APACHE-2.0"] {
        assert!(
            fork_dir().join(name).is_file(),
            "fork に上流の {name} が無い"
        );
    }
}

#[test]
fn fork_md_records_the_upstream_version_and_commit() {
    let text = fs::read_to_string(fork_dir().join("FORK.md")).expect("FORK.md が無い");
    assert!(text.contains("2.4.1"), "FORK.md に由来の版（2.4.1）が無い");
    assert!(
        text.contains("6aa2854f314481a459be1189b02c65a2450789ab"),
        "FORK.md に上流のコミットが無い"
    );
}

#[test]
fn tauri_plugin_sql_is_the_in_repo_fork_via_path_dependency() {
    let cargo = load_cargo_toml();
    let dep = &cargo["dependencies"]["tauri-plugin-sql"];
    assert_eq!(dep["path"].as_str(), Some("../tauri-plugin-sql"));
    let features: Vec<&str> = dep["features"]
        .as_array()
        .expect("features が無い")
        .iter()
        .filter_map(|f| f.as_str())
        .collect();
    assert_eq!(features, vec!["sqlite"]);
}

#[test]
fn cargo_lock_has_no_crates_io_tauri_plugin_sql() {
    let text = fs::read_to_string(manifest_dir().join("Cargo.lock")).unwrap();
    let lock: toml::Value = toml::from_str(&text).unwrap();
    let packages = lock["package"].as_array().unwrap();
    let sql: Vec<_> = packages
        .iter()
        .filter(|p| p["name"].as_str() == Some("tauri-plugin-sql"))
        .collect();
    assert_eq!(
        sql.len(),
        1,
        "tauri-plugin-sql は fork の 1 件だけ: {sql:?}"
    );
    assert!(
        sql[0].get("source").is_none(),
        "tauri-plugin-sql が crates.io 等の外部の source から来ている: {:?}",
        sql[0]
    );
}

#[test]
fn web_plugin_sql_matches_the_fork_major_minor() {
    let web: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(manifest_dir().join("../../web/package.json")).unwrap(),
    )
    .unwrap();
    let spec = web["dependencies"]["@tauri-apps/plugin-sql"]
        .as_str()
        .expect("web の dependencies に @tauri-apps/plugin-sql が無い");
    let fork: toml::Value =
        toml::from_str(&fs::read_to_string(fork_dir().join("Cargo.toml")).unwrap()).unwrap();
    let fork_version = fork["package"]["version"].as_str().unwrap();
    let major_minor = |v: &str| {
        v.trim_start_matches(['^', '~', '='])
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".")
    };
    assert_eq!(major_minor(spec), major_minor(fork_version));
}

#[test]
fn sql_plugin_preloads_only_the_app_db() {
    let conf = load_tauri_conf();
    assert_eq!(
        conf["plugins"]["sql"]["preload"],
        serde_json::json!(["sqlite:ai-boss.db"])
    );
}

/// `capabilities/` をサブディレクトリまで再帰的に走査し、capability の定義
/// ファイルとして解釈されうる拡張子（`.json`・`.json5`・`.toml`）のファイルを
/// 列挙する。
fn find_capability_files_recursively(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&current) else {
            continue;
        };
        for entry in read_dir.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path
                .extension()
                .is_some_and(|ext| ext == "json" || ext == "json5" || ext == "toml")
            {
                found.push(path);
            }
        }
    }
    found
}

#[test]
fn tauri_conf_does_not_declare_inline_capabilities() {
    // self-review（code-reviewer, CONFIRMED）: `app.security.capabilities`
    // へインラインで capability を書く経路は、上のディレクトリ走査では
    // 検出できない別の到達経路。「0件であること」を固定するには、この欄も
    // 未設定または空配列であることを別途確認する必要がある。
    let conf = load_tauri_conf();
    let capabilities = &conf["app"]["security"]["capabilities"];
    let count = match capabilities {
        serde_json::Value::Null => 0,
        serde_json::Value::Array(items) => items.len(),
        other => panic!("app.security.capabilities が配列でも未設定でもない: {other:?}"),
    };
    assert_eq!(
        count, 0,
        "app.security.capabilities にインラインの capability がある"
    );
}

// ---------------------------------------------------------------------------
// app.withGlobalTauri
// ---------------------------------------------------------------------------

#[test]
fn with_global_tauri_is_not_enabled() {
    let conf = load_tauri_conf();
    // 未設定（デフォルト false）・明示的な false のどちらでも合格。
    let enabled = conf["app"]["withGlobalTauri"].as_bool().unwrap_or(false);
    assert!(!enabled, "app.withGlobalTauri が有効になっている");
}

// ---------------------------------------------------------------------------
// CSP
// ---------------------------------------------------------------------------

#[test]
fn csp_default_src_is_self_only() {
    let conf = load_tauri_conf();
    assert!(
        conf["app"]["security"]["csp"].is_object(),
        "app.security.csp が未設定・null（オブジェクト形式でない）"
    );
    let default_src = csp_directive(&conf, "default-src");
    assert_eq!(default_src, vec!["'self'".to_string()]);
}

#[test]
fn csp_script_src_has_no_unsafe_inline_or_eval() {
    let conf = load_tauri_conf();
    let script_src = csp_directive(&conf, "script-src");
    assert!(!script_src.iter().any(|v| v == "'unsafe-inline'"));
    assert!(!script_src.iter().any(|v| v == "'unsafe-eval'"));
}

#[test]
fn csp_connect_src_has_no_external_origin() {
    let conf = load_tauri_conf();
    let connect_src = csp_directive(&conf, "connect-src");
    // 自オリジンと Tauri の IPC（`ipc:`・`http://ipc.localhost`）だけを許す
    // allowlist。1件でもこれ以外（外部の http:/https:/ws:/wss: のスキーム・
    // ホスト指定）が混ざれば不合格にする。
    let allowed: HashSet<&str> = ["'self'", "ipc:", "http://ipc.localhost"]
        .into_iter()
        .collect();
    assert!(!connect_src.is_empty(), "app.security.csp.connect-src が空");
    for value in &connect_src {
        assert!(
            allowed.contains(value.as_str()),
            "connect-src に許可されていない値が含まれる: {value:?}"
        );
    }
}

#[test]
fn csp_object_src_is_none() {
    let conf = load_tauri_conf();
    assert_eq!(
        csp_directive(&conf, "object-src"),
        vec!["'none'".to_string()]
    );
}

#[test]
fn csp_frame_src_is_none() {
    let conf = load_tauri_conf();
    assert_eq!(
        csp_directive(&conf, "frame-src"),
        vec!["'none'".to_string()]
    );
}

#[test]
fn csp_base_uri_is_none() {
    let conf = load_tauri_conf();
    assert_eq!(csp_directive(&conf, "base-uri"), vec!["'none'".to_string()]);
}

#[test]
fn csp_form_action_is_none() {
    let conf = load_tauri_conf();
    assert_eq!(
        csp_directive(&conf, "form-action"),
        vec!["'none'".to_string()]
    );
}

#[test]
fn csp_img_src_is_self_data_or_blob_only() {
    let conf = load_tauri_conf();
    let img_src = csp_directive(&conf, "img-src");
    let allowed: HashSet<&str> = ["'self'", "data:", "blob:"].into_iter().collect();
    assert!(!img_src.is_empty(), "app.security.csp.img-src が空");
    for value in &img_src {
        assert!(
            allowed.contains(value.as_str()),
            "img-src に 'self'/data:/blob: 以外の値が含まれる: {value:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// asset: プロトコル / dangerousDisableAssetCspModification
// ---------------------------------------------------------------------------

#[test]
fn dangerous_disable_asset_csp_modification_is_not_enabled() {
    let conf = load_tauri_conf();
    let value = &conf["app"]["security"]["dangerousDisableAssetCspModification"];
    // bool の `true`、または非空の配列（ディレクティブ名の一覧＝一部無効化）
    // のどちらでも不合格。未設定・`false`・空配列は合格。
    let disabled = match value {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Array(arr) => !arr.is_empty(),
        _ => false,
    };
    assert!(
        !disabled,
        "dangerousDisableAssetCspModification が有効になっている"
    );
}

#[test]
fn asset_protocol_is_not_enabled() {
    let conf = load_tauri_conf();
    let enabled = conf["app"]["security"]["assetProtocol"]["enable"]
        .as_bool()
        .unwrap_or(false);
    assert!(
        !enabled,
        "app.security.assetProtocol.enable が有効になっている"
    );
}

#[test]
fn tauri_dependency_does_not_enable_protocol_asset_feature() {
    let cargo_toml = load_cargo_toml();
    let features = cargo_toml["dependencies"]["tauri"]["features"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let has_protocol_asset = features
        .iter()
        .any(|f| f.as_str() == Some("protocol-asset"));
    assert!(
        !has_protocol_asset,
        "Cargo.toml の tauri の features に protocol-asset が含まれている"
    );
}

// ---------------------------------------------------------------------------
// 子プロセス・サイドカー・externalBin
// ---------------------------------------------------------------------------

#[test]
fn cargo_toml_does_not_depend_on_tauri_plugin_shell() {
    let cargo_toml = load_cargo_toml();
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(table) = cargo_toml.get(section).and_then(|v| v.as_table()) {
            assert!(
                !table.contains_key("tauri-plugin-shell"),
                "Cargo.toml の [{section}] に tauri-plugin-shell が含まれている"
            );
        }
    }
}

#[test]
fn tauri_conf_has_no_external_bin() {
    let conf = load_tauri_conf();
    assert!(
        conf["bundle"]["externalBin"].is_null(),
        "tauri.conf.json に bundle.externalBin がある"
    );
}

// ---------------------------------------------------------------------------
// build 設定（devUrl・frontendDist）
// ---------------------------------------------------------------------------

#[test]
fn tauri_conf_has_no_dev_url() {
    let conf = load_tauri_conf();
    assert!(
        conf["build"]["devUrl"].is_null(),
        "tauri.conf.json に build.devUrl がある（開発時も localhost の配信を読まないこと）"
    );
}

#[test]
fn tauri_conf_frontend_dist_points_to_product_web_build_output() {
    let conf = load_tauri_conf();
    let frontend_dist = conf["build"]["frontendDist"]
        .as_str()
        .unwrap_or_else(|| panic!("build.frontendDist が文字列でない"));
    // 仮定 A5: 製品版の web のビルド出力は `web/dist-app/`。
    // native/tauri-app/tauri.conf.json からの相対パスであることを踏まえ、
    // 正規化した末尾一致で検査する（`../../web/dist-app` を想定）。
    let normalized = Path::new(frontend_dist)
        .components()
        .filter(|c| !matches!(c, std::path::Component::ParentDir))
        .collect::<PathBuf>();
    assert_eq!(normalized, PathBuf::from("web/dist-app"));
}
