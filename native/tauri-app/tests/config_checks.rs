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
fn capabilities_grant_only_sql_the_five_secure_commands_the_evidence_fs_and_the_s3_desktop_permissions_to_the_main_window() {
    // #581 S3（docs/features/secure-transport-byok.md S3-C3・S3-C5）: 通信層の
    // コマンド 5 つの `allow-*` を足した（使うスライスが最小の単位で足す——
    // #579 の仕様「権限と到達経路の境界」）。`core:default` 等は足さない。
    //
    // #579 S4（docs/features/tauri-in-app-runtime.md AC-S4-4〜7）: 証跡ファイルに
    // 要る fs の 4 つ（スコープは保存先の直下だけ）を足した。fs の内訳は下の
    // AC-S4-4〜7 のテストも個別に固定する。
    //
    // #580 S2（docs/features/async-db-layer.md AC-S2-5）: #579 S2 の「0 件」を、
    // DB に要る最小の単位（`sql:allow-execute`・`sql:allow-select`）へ置き
    // 換えた。`load`（任意のパスの DB を開ける）・`close`・`sql:default` は
    // 許可しない。
    //
    // #579 S3（機能仕様 docs/features/tauri-in-app-runtime.md AC-S3-14）: さらに
    // 通知の送信（`notification:allow-notify`）と刻みのイベントの購読
    // （`core:event:allow-listen`）の 2 件を足した。`notification:default`・
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
    //
    // #585 S3（docs/features/scheduled-nudges.md「製品版のエントリの配線」）:
    // モバイル（iOS・Android）だけに効く `mobile-nudges.json` を足した（中身は
    // 下の S3 のテストが固定する）。`default.json` の中身はこのテストのまま変えない。
    let dir = manifest_dir().join("capabilities");
    let mut entries = find_capability_files_recursively(&dir);
    entries.sort();
    assert_eq!(
        entries,
        vec![dir.join("default.json"), dir.join("mobile-nudges.json")],
        "capabilities/ 配下（サブディレクトリ含む）の capability は default.json と mobile-nudges.json の 2 件だけであること"
    );
    let text = fs::read_to_string(dir.join("default.json")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(
        capability.get("webviews").is_none() && capability.get("remote").is_none(),
        "対象は main のウィンドウだけ（webviews・remote を指定しない）: {capability}"
    );
    // 権限の全体は、sql の 2 件・通信層のコマンドの 5 件（文字列）と fs の 4 件
    // （スコープ付きのオブジェクト）・S3 の通知と刻みの購読の 2 件（文字列）だけ。
    assert_eq!(
        capability["permissions"],
        serde_json::json!([
            "sql:allow-execute",
            "sql:allow-select",
            "allow-secure-send",
            "allow-secure-cancel",
            "allow-byok-key-set",
            "allow-byok-key-delete",
            "allow-byok-key-status",
            { "identifier": "fs:allow-read-file", "allow": [{ "path": "$APPCONFIG/evidence/*" }] },
            { "identifier": "fs:allow-write-file", "allow": [{ "path": "$APPCONFIG/evidence/*" }] },
            { "identifier": "fs:allow-remove", "allow": [{ "path": "$APPCONFIG/evidence/*" }] },
            { "identifier": "fs:allow-exists", "allow": [{ "path": "$APPCONFIG/evidence/*" }] },
            "notification:allow-notify",
            "core:event:allow-listen"
        ])
    );
}

/// capability の `permissions` のうち、スコープを付けたオブジェクトの形の
/// fs の権限（`{ "identifier": "fs:...", "allow": [...], "deny": [...] }`）。
fn fs_permission_objects() -> Vec<serde_json::Value> {
    let text = fs::read_to_string(manifest_dir().join("capabilities/default.json")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| {
            p.as_str().is_some_and(|s| s.starts_with("fs:"))
                || p["identifier"].as_str().is_some_and(|s| s.starts_with("fs:"))
        })
        .cloned()
        .collect()
}

#[test]
fn ac_s4_4_capability_grants_only_four_fs_permissions() {
    // #579 S4: `fs:default`・`fs:scope`・それ以外の `fs:` の権限（`mkdir`・
    // `read_dir`・`rename`・`copy_file`・`stat`・`open` を含む束）は許可しない。
    let identifiers: Vec<String> = fs_permission_objects()
        .iter()
        .map(|p| {
            p["identifier"]
                .as_str()
                .unwrap_or_else(|| panic!("fs の権限がスコープ付きのオブジェクトでない: {p}"))
                .to_owned()
        })
        .collect();
    assert_eq!(
        identifiers,
        vec![
            "fs:allow-read-file",
            "fs:allow-write-file",
            "fs:allow-remove",
            "fs:allow-exists"
        ]
    );
}

#[test]
fn ac_s4_5_capability_keeps_the_two_sql_permissions_as_plain_strings() {
    let text = fs::read_to_string(manifest_dir().join("capabilities/default.json")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&text).unwrap();
    let sql: Vec<&str> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p.as_str())
        .filter(|p| p.starts_with("sql:"))
        .collect();
    assert_eq!(sql, vec!["sql:allow-execute", "sql:allow-select"]);
}

#[test]
fn ac_s4_6_each_fs_permission_has_exactly_one_allow_scope_directly_under_evidence() {
    let permissions = fs_permission_objects();
    assert_eq!(permissions.len(), 4);
    for permission in &permissions {
        assert_eq!(
            permission["allow"],
            serde_json::json!([{ "path": "$APPCONFIG/evidence/*" }]),
            "{permission}"
        );
    }
}

#[test]
fn ac_s4_7_no_fs_permission_has_a_deny_scope() {
    for permission in fs_permission_objects() {
        assert!(permission.get("deny").is_none(), "{permission}");
    }
}

#[test]
fn ac_s4_8_cargo_lock_resolves_tauri_plugin_fs_to_2_6() {
    let text = fs::read_to_string(manifest_dir().join("Cargo.lock")).unwrap();
    let lock: toml::Value = toml::from_str(&text).unwrap();
    let fs_plugin: Vec<_> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["name"].as_str() == Some("tauri-plugin-fs"))
        .collect();
    assert_eq!(fs_plugin.len(), 1, "tauri-plugin-fs は 1 件だけ: {fs_plugin:?}");
    let version = fs_plugin[0]["version"].as_str().unwrap();
    assert!(version.starts_with("2.6."), "tauri-plugin-fs が 2.6 系でない: {version}");
}

#[test]
fn ac_s4_9_web_plugin_fs_matches_the_crate_major_minor() {
    let web: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(manifest_dir().join("../../web/package.json")).unwrap(),
    )
    .unwrap();
    let spec = web["dependencies"]["@tauri-apps/plugin-fs"]
        .as_str()
        .expect("web の dependencies に @tauri-apps/plugin-fs が無い");
    let lock: toml::Value =
        toml::from_str(&fs::read_to_string(manifest_dir().join("Cargo.lock")).unwrap()).unwrap();
    let crate_version = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"].as_str() == Some("tauri-plugin-fs"))
        .and_then(|p| p["version"].as_str())
        .expect("Cargo.lock に tauri-plugin-fs が無い");
    let major_minor = |v: &str| {
        v.trim_start_matches(['^', '~', '='])
            .split('.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".")
    };
    assert_eq!(major_minor(spec), major_minor(crate_version));
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

// ---------------------------------------------------------------------------
// 通知プラグインの fork と、催促の予約に要る権限（#585 S3・機能仕様
// docs/features/scheduled-nudges.md「通知プラグインの fork」「製品版のエントリの
// 配線」・受入基準（S3）「器の設定」）
// ---------------------------------------------------------------------------

fn notification_fork_dir() -> PathBuf {
    manifest_dir().join("../tauri-plugin-notification")
}

const MOBILE_ONLY_NOTIFICATION_PERMISSIONS: [&str; 2] =
    ["notification:allow-cancel", "notification:allow-get-pending"];

fn load_capability(path: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn permission_identifiers(capability: &serde_json::Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .expect("permissions が配列でない")
        .iter()
        .map(|p| match p {
            serde_json::Value::String(id) => id.clone(),
            other => other["identifier"].as_str().unwrap_or_default().to_string(),
        })
        .collect()
}

fn platforms_of(capability: &serde_json::Value) -> Option<Vec<String>> {
    capability.get("platforms").map(|p| {
        let mut platforms: Vec<String> = p
            .as_array()
            .expect("platforms が配列でない")
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        platforms.sort();
        platforms
    })
}

#[test]
fn tauri_plugin_notification_is_the_in_repo_fork_via_path_dependency() {
    let cargo = load_cargo_toml();
    let dep = &cargo["dependencies"]["tauri-plugin-notification"];
    assert_eq!(dep["path"].as_str(), Some("../tauri-plugin-notification"));
    assert!(dep.get("version").is_none(), "crates.io の版を併記しない: {dep:?}");
}

#[test]
fn cargo_lock_has_no_crates_io_tauri_plugin_notification() {
    let text = fs::read_to_string(manifest_dir().join("Cargo.lock")).unwrap();
    let lock: toml::Value = toml::from_str(&text).unwrap();
    let notification: Vec<_> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["name"].as_str() == Some("tauri-plugin-notification"))
        .collect();
    assert_eq!(notification.len(), 1, "tauri-plugin-notification は fork の 1 件だけ: {notification:?}");
    assert!(
        notification[0].get("source").is_none(),
        "tauri-plugin-notification が crates.io 等の外部の source から来ている: {:?}",
        notification[0]
    );
}

#[test]
fn notification_fork_keeps_upstream_license_files() {
    for name in ["LICENSE_MIT", "LICENSE_APACHE-2.0", "LICENSE.spdx"] {
        assert!(notification_fork_dir().join(name).is_file(), "fork に上流の {name} が無い");
    }
}

#[test]
fn notification_fork_md_records_the_origin_and_the_two_differences() {
    let text = fs::read_to_string(notification_fork_dir().join("FORK.md")).expect("FORK.md が無い");
    assert!(text.contains("2.5.0"), "FORK.md に由来の版（2.5.0）が無い");
    assert!(
        text.contains("a2364a5f216324439feedeb25b2db74e7b1eba90"),
        "FORK.md に上流のコミットが無い"
    );
    assert!(text.contains("差分 1: iOS の予約時刻を UTC として読む"), "FORK.md に差分 1 が無い");
    assert!(text.contains("差分 2: iOS の `show` は"), "FORK.md に差分 2 が無い");
    for needle in ["UTC", "UNUserNotificationCenter.add", "拒否"] {
        assert!(text.contains(needle), "FORK.md に「{needle}」が無い（差分 1・2）");
    }
    let fork: toml::Value =
        toml::from_str(&fs::read_to_string(notification_fork_dir().join("Cargo.toml")).unwrap()).unwrap();
    assert_eq!(fork["package"]["version"].as_str(), Some("2.5.0"));
}

#[test]
fn mobile_only_notification_permissions_are_in_a_capability_limited_to_ios_and_android() {
    let path = manifest_dir().join("capabilities/mobile-nudges.json");
    let capability = load_capability(&path);
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    assert!(
        capability.get("webviews").is_none() && capability.get("remote").is_none(),
        "対象は main のウィンドウだけ: {capability}"
    );
    assert_eq!(
        platforms_of(&capability),
        Some(vec!["android".to_string(), "iOS".to_string()]),
        "platforms は iOS・Android だけ"
    );
    assert_eq!(permission_identifiers(&capability), MOBILE_ONLY_NOTIFICATION_PERMISSIONS);
}

#[test]
fn cancel_and_get_pending_are_granted_only_by_capabilities_limited_to_ios_and_android() {
    let dir = manifest_dir().join("capabilities");
    for path in find_capability_files_recursively(&dir) {
        let capability = load_capability(&path);
        let granted: Vec<String> = permission_identifiers(&capability)
            .into_iter()
            .filter(|id| MOBILE_ONLY_NOTIFICATION_PERMISSIONS.contains(&id.as_str()) || id == "notification:default")
            .collect();
        if granted.is_empty() {
            continue;
        }
        assert_eq!(
            platforms_of(&capability),
            Some(vec!["android".to_string(), "iOS".to_string()]),
            "{} が {granted:?} を、iOS・Android に限らずに許している",
            path.display()
        );
        assert!(
            !granted.contains(&"notification:default".to_string()),
            "{} が notification:default を許している",
            path.display()
        );
    }
}

#[test]
fn default_capability_applies_to_every_platform_and_grants_only_notify_for_notifications() {
    let capability = load_capability(&manifest_dir().join("capabilities/default.json"));
    assert!(capability.get("platforms").is_none(), "default.json は platforms を指定しない（macOS に効く）");
    let notification: Vec<String> = permission_identifiers(&capability)
        .into_iter()
        .filter(|id| id.starts_with("notification:"))
        .collect();
    assert_eq!(notification, vec!["notification:allow-notify".to_string()]);
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

// ---------------------------------------------------------------------------
// iOS の器（#669 S1・機能仕様 docs/features/ios-shell.md 受入基準（S1））
// ---------------------------------------------------------------------------

/// デスクトップのターゲットだけの依存の表（決定 1）。
const DESKTOP_ONLY_TARGET: &str = r#"cfg(not(any(target_os = "android", target_os = "ios")))"#;

fn desktop_only_dependencies(cargo_toml: &toml::Value) -> &toml::value::Table {
    cargo_toml["target"]
        .get(DESKTOP_ONLY_TARGET)
        .and_then(|target| target.get("dependencies"))
        .and_then(|deps| deps.as_table())
        .unwrap_or_else(|| {
            panic!("Cargo.toml に [target.'{DESKTOP_ONLY_TARGET}'.dependencies] が無い")
        })
}

#[test]
fn single_instance_is_a_dependency_of_the_desktop_targets_only() {
    let cargo_toml = load_cargo_toml();
    assert!(
        desktop_only_dependencies(&cargo_toml).contains_key("tauri-plugin-single-instance"),
        "tauri-plugin-single-instance がデスクトップのターゲットの依存の表に無い"
    );
    assert!(
        !cargo_toml["dependencies"]
            .as_table()
            .unwrap()
            .contains_key("tauri-plugin-single-instance"),
        "tauri-plugin-single-instance が共通の [dependencies] にある（モバイルでは init が無い）"
    );
}

#[test]
fn single_instance_stays_pinned_to_2_5() {
    let cargo_toml = load_cargo_toml();
    assert_eq!(
        desktop_only_dependencies(&cargo_toml)["tauri-plugin-single-instance"].as_str(),
        Some("~2.5")
    );
}

#[test]
fn tauri_dependency_keeps_the_tray_icon_feature() {
    let cargo_toml = load_cargo_toml();
    let features = cargo_toml["dependencies"]["tauri"]["features"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        features.iter().any(|f| f.as_str() == Some("tray-icon")),
        "Cargo.toml の tauri の features に tray-icon が無い（macOS のメニューバー常駐）"
    );
}

/// `src/lib.rs` の本文。
fn load_lib_rs() -> String {
    let path = manifest_dir().join("src/lib.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

/// 空白を除き、rustfmt の末尾カンマ（`,)`）を `)` に寄せる。rustfmt の改行・末尾カンマに依らずに比べるため。
fn compact(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect::<String>().replace(",)", ")")
}

/// `source` の中の関数 `name` を 1 つだけ取り出し、正規化したシグネチャ（最初の `{` の手前まで）と
/// 本体（最初の `{` の直後から、関数を閉じる行頭の `}` の直前まで）を返す（#683・#685・#687・#693）。
/// 照らす前にコメント（`//`・`///`・入れ子を含む `/* */`）を字句として取り除き（文字列・文字の
/// リテラルの中の `//`・`/*` はコメントとみなさない）、生の識別子 `r#name` を `name` に寄せる。
/// 次のいずれかなら panic する（配線のすり替えの抜け道を塞ぐ）:
/// - 定義がちょうど 1 つではない、括弧のブロックの中にある、定義の行の `fn` より左が修飾子だけではない、
///   外側の属性・項目の並びの始まりの内側の属性に `cfg` がある（[`single_top_level_definition`]。
///   `pub` の有無を問わず照らす部分）
/// - その定義が行頭の `pub fn name` ではない
///
/// コメントを先に取り除くため、ブロックコメントの中の `}`・`;` で並びの遡りが止まることはない
/// （#687 low (a)）。doc コメントは属性だが中身を照らさない（`cfg` の語を含む説明を書けるように）。
/// マクロ・`include!` で生成される定義は対象外（ソースの文面に現れないため）。
fn top_level_fn(source: &str, name: &str) -> (String, String) {
    let start = single_top_level_definition(source, name);
    let code = strip_comments(source, false);
    let lines: Vec<&str> = code.lines().collect();
    assert!(
        lines[start].starts_with(&format!("pub fn {name}")),
        "src/lib.rs の fn {name} が行頭の pub fn ではない: {}",
        lines[start]
    );
    let end = lines[start..]
        .iter()
        .position(|line| line.starts_with('}'))
        .map(|offset| start + offset)
        .unwrap_or_else(|| panic!("src/lib.rs の fn {name} を閉じる行頭の `}}` が無い"));
    let text = lines[start..end].join("\n");
    let (signature, body) = text
        .split_once('{')
        .unwrap_or_else(|| panic!("fn {name} のシグネチャに `{{` が無い: {text}"));
    (compact(signature), compact(body))
}

/// `source` の中の関数 `name` の定義の行の番号（0 始まり）を返す。`pub` の有無・本体の形は問わない
/// （#683・#685・#687・#693）。次のいずれかなら panic する（配線のすり替えの抜け道を塞ぐ）:
/// - `fn name<` / `fn name(` が（入れ子・`pub` の有無・`r#` の有無・間の空白やコメントを問わず）
///   ちょうど 1 回ではない（`#[cfg(target_os = "ios")]` 側だけ別の定義を並べると、ホストでは片方しか
///   照らせない。[`definition_offsets`]）
/// - その定義が括弧（`( )`・`[ ]`・`{ }`）のブロックの中にある（`mod`・`cfg_if!`・丸／角括弧の
///   マクロ呼び出し等。字下げに依らず、定義の行の行頭より手前の開きと閉じの数の差がそれぞれ 0 かで見る）
/// - 定義の行の `fn` より左が修飾子（`pub`・`pub(..)`・`const`・`async`・`unsafe`・`extern "..."`）
///   だけではない（同じ行の属性 `#[cfg(..)] fn`・マクロの開き `not_ios!(fn`・`mod m { fn` は、行頭より
///   手前だけを見る上と下の確認をすり抜けるため。[`is_fn_qualifiers`]）
/// - その定義に付いた外側の属性（直前に空白・コメントだけを挟んで連なる `#[...]` の並び。
///   複数行の属性を含む）に `cfg` がある。並びは前の項目の終わりの `}`・`;`（1 行で閉じる項目を
///   含む）で止まり、それより前の項目の属性は見ない。並びの始まりの内側の属性（`#![...]`）に
///   `cfg(` があっても panic する（[`outer_attributes`]）
fn single_top_level_definition(source: &str, name: &str) -> usize {
    let blanked = strip_comments(source, true);
    // リテラルの中身を空白にした版で数える（文字列の中の `fn name(` を定義とみなさない）。
    let definitions = definition_offsets(&blanked, name);
    let line_of = |offset: usize| blanked[..offset].matches('\n').count();
    assert_eq!(
        definitions.len(),
        1,
        "src/lib.rs の fn {name} の定義がちょうど 1 つではない（cfg で分けた定義はホストでは片方しか照らせない）: 行 {:?}",
        definitions.iter().map(|&i| line_of(i) + 1).collect::<Vec<_>>()
    );
    let fn_offset = definitions[0];
    let start = line_of(fn_offset);
    let offset = blanked[..fn_offset].rfind('\n').map_or(0, |i| i + 1);
    let qualifiers = &blanked[offset..fn_offset];
    assert!(
        is_fn_qualifiers(qualifiers),
        "src/lib.rs の fn {name} の定義の行の fn より左が修飾子だけではない（同じ行の属性・マクロの開き・mod 等で定義を差し替えられる）: {qualifiers:?}"
    );
    let before = &blanked[..offset];
    let depths = [('(', ')'), ('[', ']'), ('{', '}')].map(|(open, close)| {
        before.matches(open).count() as isize - before.matches(close).count() as isize
    });
    assert_eq!(
        depths, [0, 0, 0],
        "src/lib.rs の fn {name} が括弧（`( )`・`[ ]`・`{{ }}`）のブロックの中にある（mod・cfg_if!・丸／角括弧のマクロ呼び出し等の cfg で定義を差し替えられる）: 深さ（丸・角・波）"
    );
    let attributes = outer_attributes(before);
    assert!(
        attributes.iter().all(|attribute| !attribute.contains("cfg")),
        "src/lib.rs の fn {name} に cfg の属性がある（ビルド対象ごとに定義を差し替えられる）: {attributes:?}"
    );
    start
}

/// `text` が関数の修飾子（`pub`・`pub(crate)` 等の `pub(..)`・`const`・`async`・`unsafe`・
/// `extern "..."`）と空白だけでできているか（#693）。`text` は [`strip_comments`] でリテラルの中身を
/// 空白にしたもの（`extern` の ABI の文字列の中身は空白になっている）。
fn is_fn_qualifiers(text: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut rest = text;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            return true;
        }
        let (word, after) = rest.split_at(rest.find(|c| !is_ident(c)).unwrap_or(rest.len()));
        rest = match word {
            "const" | "async" | "unsafe" => after,
            "pub" => match after.trim_start().strip_prefix('(') {
                Some(inner) => match inner.split_once(')') {
                    Some((path, after))
                        if path
                            .chars()
                            .all(|c| is_ident(c) || c == ':' || c.is_whitespace()) =>
                    {
                        after
                    }
                    _ => return false,
                },
                None => after,
            },
            "extern" => match after.trim_start().strip_prefix('"') {
                Some(abi) => match abi.split_once('"') {
                    Some((_, after)) => after,
                    None => return false,
                },
                None => after,
            },
            _ => return false,
        };
    }
}

/// Rust のソースからコメント（`//`・入れ子を含む `/* */`）を取り除き、生の識別子 `r#name` を `name` に
/// 寄せる（#687）。改行は残す（行の番号を変えない）。文字列（生の文字列を含む）・文字のリテラルは
/// 字句として読み飛ばし、`blank_literals` なら中身を空白に置き換える（属性の括弧の対応を、
/// リテラルの中の `[`・`]` に惑わされずに数えるため）。ライフタイムの `'a` は文字のリテラルと区別する。
fn strip_comments(source: &str, blank_literals: bool) -> String {
    let chars: Vec<char> = source.chars().collect();
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let literal = |out: &mut String, c: char| {
        out.push(if blank_literals && c != '\n' { ' ' } else { c });
    };
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let after_ident = i > 0 && is_ident(chars[i - 1]);
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let mut depth = 0;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            out.push(' ');
        } else if c == 'r'
            && (!after_ident
                || (matches!(chars[i - 1], 'b' | 'c') && (i < 2 || !is_ident(chars[i - 2]))))
            && matches!(next, Some('#' | '"'))
        {
            let hashes = chars[i + 1..].iter().take_while(|&&h| h == '#').count();
            if chars.get(i + 1 + hashes) == Some(&'"') {
                // 生の文字列 `r#"..."#`（`br"..."`・`cr"..."` を含む）。閉じる `"` と同じ数の `#` まで。
                let open = i + 2 + hashes;
                out.extend(&chars[i..open]);
                let close = (open..chars.len())
                    .find(|&j| {
                        chars[j] == '"'
                            && chars[j + 1..].iter().take_while(|&&h| h == '#').count() >= hashes
                    })
                    .unwrap_or(chars.len());
                for &ch in &chars[open..close] {
                    literal(&mut out, ch);
                }
                let end = (close + 1 + hashes).min(chars.len());
                out.extend(&chars[close.min(end)..end]);
                i = end;
            } else if hashes == 1 && chars.get(i + 2).is_some_and(|&ch| is_ident(ch)) {
                // 生の識別子 `r#name` は `name` と同じ名前。
                i += 2;
            } else {
                out.push(c);
                i += 1;
            }
        } else if c == '"' {
            out.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                if ch == '\\' {
                    literal(&mut out, ch);
                    if let Some(&escaped) = chars.get(i + 1) {
                        literal(&mut out, escaped);
                    }
                    i += 2;
                } else {
                    i += 1;
                    if ch == '"' {
                        out.push(ch);
                        break;
                    }
                    literal(&mut out, ch);
                }
            }
        } else if c == '\'' && (next == Some('\\') || chars.get(i + 2) == Some(&'\'')) {
            // 文字のリテラル（`'x'`・`'\n'`・`'\u{..}'`）。ライフタイム（`'a`）はここに来ない。
            let first = if next == Some('\\') { i + 3 } else { i + 2 };
            let close = (first..chars.len())
                .find(|&j| chars[j] == '\'')
                .unwrap_or(chars.len() - 1);
            out.push(c);
            for &ch in &chars[i + 1..close] {
                literal(&mut out, ch);
            }
            out.push('\'');
            i = close + 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// 項目の手前までのソース `before`（[`strip_comments`] でリテラルの中身を空白にしたもの）の末尾に
/// 連なる外側の属性（`#[...]`）を、近い順に返す（#687・#693）。末尾から空白を飛ばし、`]` で終わる
/// 属性だけを括弧の対応で遡り、前の項目の終わり（`}`・`;`）かファイルの先頭で止まる。内側の属性
/// （`#![...]`）はファイル・`mod` の先頭に付いて項目に付くものではないため集めないが、遡りは続ける
/// （その手前の内側の属性も見る）。内側の属性の中身に `cfg(`（`cfg_attr(.., cfg(..))` の中を含む）が
/// あれば、ファイル・`mod` ごと差し替えられるため panic する（`cfg_attr(test, allow(..))` 等は通す）。
/// `#` の付かない `]` や、それ以外の文字で止まる形は項目の間に現れないため、照らせない形として
/// panic する（安全側に倒す）。
fn outer_attributes(before: &str) -> Vec<String> {
    let mut before = before.trim_end();
    let mut attributes = Vec::new();
    while let Some(rest) = before.strip_suffix(']') {
        let mut depth = 1;
        let open = rest
            .char_indices()
            .rev()
            .find(|&(_, c)| {
                match c {
                    ']' => depth += 1,
                    '[' => depth -= 1,
                    _ => {}
                }
                depth == 0
            })
            .map(|(index, _)| index)
            .unwrap_or_else(|| panic!("属性の `[` が見つからない: {before}"));
        let head = rest[..open].trim_end();
        let (head, inner) = head
            .strip_suffix('!')
            .map_or((head, false), |head| (head.trim_end(), true));
        before = head
            .strip_suffix('#')
            .unwrap_or_else(|| panic!("項目の直前に `#` の付かない `]` がある: {}", &rest[open..]))
            .trim_end();
        if inner {
            // 内側の `cfg(..)` はファイル・`mod` ごと差し替えられるため、素通りさせない。中身の
            // どこにあっても見る（`cfg_attr(.., cfg(..))` を含む）。語の `cfg` に限り、`cfg_attr` は通す。
            let content = &rest[open + 1..];
            let has_cfg = content.match_indices("cfg").any(|(index, _)| {
                !content[..index].ends_with(|c: char| c.is_alphanumeric() || c == '_')
                    && content[index + 3..].trim_start().starts_with('(')
            });
            assert!(
                !has_cfg,
                "項目の並びの始まりに内側の cfg の属性がある: {}]",
                &rest[open..]
            );
        } else {
            attributes.push(format!("{}]", &rest[open..]));
        }
    }
    // 末尾の 40 文字（byte で切ると、多バイト文字の途中で別の panic にすり替わる）。
    let tail_start = before
        .char_indices()
        .rev()
        .nth(39)
        .map_or(0, |(index, _)| index);
    assert!(
        before.is_empty() || before.ends_with(['}', ';']),
        "項目の属性の並びの手前が前の項目の終わり（`}}`・`;`）ではない: {:?}",
        &before[tail_start..]
    );
    attributes
}

/// `code`（[`strip_comments`] を通したもの）の中で、`fn` の直後に空白を挟んで `name` が続き、さらに
/// 空白を挟んで `<`・`(` が続く箇所の、`fn` の byte の位置を返す。字句の単位で照らすため、
/// `fn  name (`・コメントを挟んだ `fn /**/name(`・改行をまたぐ形も数える（#687）。
fn definition_offsets(code: &str, name: &str) -> Vec<usize> {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut words = Vec::new();
    let mut word_start = None;
    for (i, c) in code.char_indices().chain([(code.len(), ' ')]) {
        match (is_ident(c), word_start) {
            (true, None) => word_start = Some(i),
            (false, Some(s)) => {
                words.push((s, i));
                word_start = None;
            }
            _ => {}
        }
    }
    words
        .windows(2)
        .filter(|pair| {
            let [(fn_start, fn_end), (name_start, name_end)] = [pair[0], pair[1]];
            &code[fn_start..fn_end] == "fn"
                && &code[name_start..name_end] == name
                && code[fn_end..name_start].trim().is_empty()
                && code[name_end..].trim_start().starts_with(['<', '('])
        })
        .map(|pair| pair[0].0)
        .collect()
}

// `top_level_fn` 自体の検査（#687）。製品の `lib.rs` では起きない形を、合成したソースで固定する。

#[test]
fn top_level_fn_ignores_the_name_inside_string_and_char_literals() {
    // 文字列・文字のリテラルの中の `fn f(` は定義として数えない（偽陽性で落とさない）。
    // 先頭の `'"'` は `"` を含む文字リテラル（#693）。字句として読まないと、この `"` で文字列が
    // 開いて、続く `"fn f("` の中身が文字列の外に出て定義に数えられる。
    let source = "const Q: char = '\"';\nconst NOTE: &str = \"fn f(\";\nconst RAW: &str = r#\"fn f<\"#;\n\npub fn f() {\n    good()\n}\n";
    let (signature, body) = top_level_fn(source, "f");
    assert_eq!(signature, "pubfnf()"); // 照合用に空白を詰めた形（`compact`）
    assert_eq!(body, "good()");
}

#[test]
#[should_panic(expected = "ちょうど 1 つではない")]
fn top_level_fn_counts_a_raw_identifier_as_another_definition() {
    // #687 low (a)・#693: iOS 側を生の識別子 `r#f` で定義する迂回。`r#` を寄せないと定義が 1 つに
    // 見えて、cfg の assert（別のメッセージ）で落ちる。ブロックコメント越しの遡りは、定義が 1 つの
    // 次のテスト（`top_level_fn_sees_a_cfg_hidden_behind_a_block_comment`）が担う。
    let source = "#[cfg(not(target_os = \"ios\"))]\npub fn f() {\n    good()\n}\n\n#[cfg(target_os = \"ios\")]\npub fn r#f() {\n    bad()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn top_level_fn_sees_a_cfg_hidden_behind_a_block_comment() {
    // #687 low (a): ブロックコメントの中の `}`・`note;` で並びの遡りを止め、iOS 側を `use` で差し替える
    // 迂回。定義は 1 つなので cfg で落とす。
    let source = "#[cfg(not(target_os = \"ios\"))]\n/*\n}\nnote;\n*/\npub fn f() {\n    good()\n}\n\n#[cfg(target_os = \"ios\")]\nuse other_mod::f;\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn top_level_fn_sees_a_cfg_split_over_lines() {
    let source = "fn before() {\n}\n\n#[doc = \"]\"]\n# [cfg(\n    not(target_os = \"ios\")\n)]\npub fn f() {\n    good()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "ブロックの中にある")]
fn top_level_fn_sees_a_cfg_on_an_unindented_enclosing_mod() {
    // 字下げしない `mod` の中に置き、cfg を `mod` に付けて iOS 側を再エクスポートで差し替える形。
    let source = "#[cfg(not(target_os = \"ios\"))]\nmod imp {\npub fn f() {\n    good()\n}\n}\n#[cfg(target_os = \"ios\")]\npub use ios::f;\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "ブロックの中にある")]
fn top_level_fn_sees_a_cfg_if_block_around_it() {
    // `cfg_if!` の分岐は rustfmt が整形しないため、字下げせずに書ける。
    let source = "cfg_if::cfg_if! {\nif #[cfg(not(target_os = \"ios\"))] {\npub fn f() {\n    good()\n}\n} else {\npub use ios::f;\n}\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "ちょうど 1 つではない")]
fn top_level_fn_counts_a_definition_split_by_a_comment_or_spaces() {
    let source = "pub fn f() {\n    good()\n}\n\n#[cfg(target_os = \"ios\")]\npub fn /**/f () {\n    bad()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn top_level_fn_reads_a_raw_c_string_as_raw() {
    // `cr"\"` の `\` はエスケープではない。エスケープと読むと続く `"` までを文字列に飲み込み、cfg を見落とす。
    let source = "const C: &core::ffi::CStr = cr\"\\\";\n#[cfg(not(target_os = \"ios\"))]\npub fn f() {\n    g(\"x\")\n}\n";
    top_level_fn(source, "f");
}

#[test]
fn top_level_fn_stops_at_a_one_line_item_before_it() {
    // #687 low (b): 1 行で閉じる直前の項目を項目の終わりとして扱い、さらに前の cfg を見ない。
    let source = "#[cfg(not(target_os = \"ios\"))]\nfn before() {\n}\n\n#[cfg(desktop)] fn noop() {}\n/// cfg の説明\n#[inline]\npub fn f() {\n    good()\n}\n";
    assert_eq!(
        top_level_fn(source, "f"),
        ("pubfnf()".to_string(), "good()".to_string())
    );
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn top_level_fn_sees_a_cfg_hidden_behind_a_nested_block_comment() {
    // #693 low ③: 入れ子のブロックコメント。入れ子を数えず最初の `*/` で閉じると、続く
    // `fn x() {}` の `}` で遡りが止まって cfg を見落とす（`// */` は行コメント）。
    let source =
        "#[cfg(not(target_os = \"ios\"))]\n/* /* */ fn x() {} // */\npub fn f() {\n    good()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "ブロックの中にある")]
fn top_level_fn_rejects_a_definition_inside_a_paren_macro_call() {
    // #693 medium 1: 丸括弧で囲むマクロ呼び出しの中に定義を置き、iOS 側を再エクスポートで差し替える形。
    // `{ }` の深さだけでは 0 に見えて通り抜ける。
    let source = "not_ios!(\nfn helper() {}\npub fn f() {\n    good()\n}\n);\n#[cfg(target_os = \"ios\")]\npub use ios_wiring::f;\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "ブロックの中にある")]
fn top_level_fn_rejects_a_definition_inside_a_bracket_macro_call() {
    // #693 medium 1: 角括弧で囲む形（`not_ios![ ... ];`）。
    let source = "not_ios![\nfn helper() {}\npub fn f() {\n    good()\n}\n];\n#[cfg(target_os = \"ios\")]\npub use ios_wiring::f;\n";
    top_level_fn(source, "f");
}

#[test]
fn top_level_fn_does_not_take_an_inner_attribute_for_an_outer_one() {
    // #693 low ⑥: ファイル先頭の `#![cfg_attr(..)]` は項目に付く外側の属性ではない。
    let source = "#![cfg_attr(test, allow(dead_code))]\npub fn f() {\n    good()\n}\n";
    assert_eq!(
        top_level_fn(source, "f"),
        ("pubfnf()".to_string(), "good()".to_string())
    );
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn top_level_fn_sees_an_outer_cfg_after_an_inner_attribute() {
    // #693 low ⑥: 内側の属性を除いても、その後ろに付いた外側の cfg は見る。
    let source =
        "#![allow(dead_code)]\n#[cfg(not(target_os = \"ios\"))]\npub fn f() {\n    good()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "前の項目の終わり")]
fn outer_attributes_reports_a_multibyte_tail_without_a_char_boundary_panic() {
    // #693 low ⑤: 失敗メッセージに載せる末尾を byte で切ると、多バイト文字の途中で別の panic
    // （`is not a char boundary`）にすり替わる。「あ」は 3 byte で 150 byte あり、末尾から 40 byte の
    // 位置（110 byte 目）は文字の途中。40 文字より長いため、末尾の 40 文字を切り出す側も踏む。
    outer_attributes(&"あ".repeat(50));
}

#[test]
#[should_panic(expected = "内側の cfg の属性がある")]
fn top_level_fn_sees_an_inner_cfg_before_it() {
    // #693 low ⑥: 内側の属性を集めない代わりに、`#![cfg(..)]` は素通りさせない。
    let source = "#![cfg(not(target_os = \"ios\"))]\npub fn f() {\n    good()\n}\n";
    top_level_fn(source, "f");
}

#[test]
#[should_panic(expected = "`#` の付かない")]
fn outer_attributes_does_not_take_a_macro_call_for_an_inner_attribute() {
    // `#![...]` の `!` と、`name![...]` の `!` を取り違えない（`#` の確認を内側の属性でも省かない）。
    outer_attributes("not_ios![x]");
}

#[test]
fn single_top_level_definition_returns_the_line_of_a_private_fn() {
    // `pub` でない関数も照らせる（`top_level_fn` の「行頭の `pub fn`」はここに含めない）。
    let source = "use a::b;\n\nfn helper(x: u8) -> u8 {\n    x\n}\n";
    assert_eq!(single_top_level_definition(source, "helper"), 2);
}

#[test]
#[should_panic(expected = "ちょうど 1 つではない")]
fn single_top_level_definition_counts_cfg_split_private_definitions() {
    // `pub` でない関数に cfg の 2 定義を並べて、ホストでは片方しか照らせなくする形。
    let source = "#[cfg(not(target_os = \"ios\"))]\nfn helper() {\n    good()\n}\n\n#[cfg(target_os = \"ios\")]\nfn helper() {\n    bad()\n}\n";
    single_top_level_definition(source, "helper");
}

#[test]
#[should_panic(expected = "cfg の属性がある")]
fn single_top_level_definition_sees_a_cfg_on_a_single_private_definition() {
    // 定義が 1 つでも、cfg が付いていれば、別のターゲットでは定義が無いか別の物に差し替わる。
    let source = "#[cfg(not(target_os = \"ios\"))]\nfn helper() {\n    good()\n}\n";
    single_top_level_definition(source, "helper");
}

#[test]
#[should_panic(expected = "修飾子だけではない")]
fn single_top_level_definition_sees_a_cfg_on_the_same_line() {
    // #697 medium (a): 外側の cfg を定義と同じ行に書き、iOS 側を `mod`＋`use` で差し替える形。
    // 行頭より手前だけを遡ると属性が見えない。
    let source = "#[cfg(not(target_os = \"ios\"))] fn helper<R: Runtime>() {\n    good()\n}\n\n#[cfg(target_os = \"ios\")]\nmod ios_backup;\n#[cfg(target_os = \"ios\")]\nuse ios_backup::helper;\n";
    single_top_level_definition(source, "helper");
}

#[test]
#[should_panic(expected = "修飾子だけではない")]
fn single_top_level_definition_sees_a_macro_call_opened_on_the_same_line() {
    // #697 medium (b): マクロの開きを定義と同じ行に書く形。行頭より手前の括弧の深さは 0 に見える。
    let source = "not_ios!(pub fn helper(exclude: bool) {\n    good()\n});\n#[cfg(target_os = \"ios\")]\npub use ios_backup::helper;\n";
    single_top_level_definition(source, "helper");
}

#[test]
#[should_panic(expected = "修飾子だけではない")]
fn single_top_level_definition_sees_a_mod_opened_on_the_same_line() {
    // #697 medium (c): `mod m {` を定義と同じ行に書き、cfg を `mod` に付ける形。
    let source = "#[cfg(not(target_os = \"ios\"))]\nmod m { pub fn helper() {\n    good()\n}\n}\n";
    single_top_level_definition(source, "helper");
}

#[test]
fn single_top_level_definition_accepts_qualifiers_left_of_fn() {
    // 修飾子（`pub(crate)`・`pub(in ..)`・`const`・`async`・`unsafe`・`extern "C"`）だけなら通す。
    for qualifiers in [
        "",
        "pub ",
        "pub(crate) ",
        "pub(in crate::a) const ",
        "pub async unsafe ",
        "pub unsafe extern \"C\" ",
    ] {
        let source = format!("use a::b;\n\n{qualifiers}fn helper() {{\n    good()\n}}\n");
        assert_eq!(
            single_top_level_definition(&source, "helper"),
            2,
            "{qualifiers:?}"
        );
    }
}

#[test]
#[should_panic(expected = "内側の cfg の属性がある")]
fn single_top_level_definition_sees_an_inner_cfg_before_another_inner_attribute() {
    // #697 low (d): 内側の `#![cfg(..)]` の後ろに別の内側の属性を置き、最初の内側の属性で遡りを
    // 止めさせる形。
    let source = "#![cfg(not(target_os = \"ios\"))]\n#![allow(dead_code)]\npub fn helper() {\n    good()\n}\n";
    single_top_level_definition(source, "helper");
}

#[test]
#[should_panic(expected = "内側の cfg の属性がある")]
fn single_top_level_definition_sees_a_cfg_inside_an_inner_cfg_attr() {
    // #697 low (e): `cfg_attr` の中に `cfg(..)` を入れ、先頭が `cfg(` かだけを見る確認をすり抜ける形。
    let source =
        "#![cfg_attr(target_os = \"ios\", cfg(any()))]\npub fn helper() {\n    good()\n}\n";
    single_top_level_definition(source, "helper");
}

#[test]
fn top_level_fn_keeps_comment_markers_inside_literals() {
    // 文字列・文字のリテラルの中の `//`・`/*` はコメントではない（照合の対象に残す）。
    let source = "/// `$APPCONFIG/evidence/*` の直下\npub fn f<'a>() {\n    call(\"a//b /* c */\", r#\"//\"#, '\"', '/', '\\'', '[') // note\n}\n";
    assert_eq!(
        top_level_fn(source, "f"),
        (
            "pubfnf<'a>()".to_string(),
            "call(\"a//b/*c*/\",r#\"//\"#,'\"','/','\\'','[')".to_string()
        )
    );
}

#[test]
fn run_is_the_mobile_entry_point() {
    let source = load_lib_rs();
    // 属性の直後の項目が `pub fn run()` であること（別の関数に付いていない）。
    let lines: Vec<&str> = source.lines().map(str::trim).collect();
    let found = lines.windows(2).any(|pair| {
        pair[0] == "#[cfg_attr(mobile, tauri::mobile_entry_point)]" && pair[1] == "pub fn run() {"
    });
    assert!(
        found,
        "src/lib.rs の pub fn run() の直前に #[cfg_attr(mobile, tauri::mobile_entry_point)] が無い"
    );
}

/// 製品の `configure_with` が、ビルド対象の除外（`backup_exclusion_for(EXCLUDES_APP_DATA_FROM_BACKUP)`）
/// を渡していること（#681・#683・#685）。ホストでは定数が false で、`None`・`backup_exclusion_for(false)`
/// と実行時に区別できない（iOS の実観測は #682）ため、`run_is_the_mobile_entry_point` と
/// 同じくソースの文面で配線を固定する。関数の本体の全体が、その 1 つの呼び出しと完全に一致する
/// ことを照らす（空白を除き、rustfmt の改行・末尾カンマに依らない）。部分一致ではないため、
/// ブロックコメント・到達しない分岐・余計な文・後置（`.and(None)` 等）に正しい呼び出しを
/// 紛れ込ませても通らない。シグネチャも完全一致で照らし（引数・const generic を足して呼び出し側で
/// 値を差し替える形を塞ぐ）、定義がちょうど 1 つで cfg の属性が付いていないことも確かめる
/// （iOS 側だけ `None` を渡す定義を並べる形を塞ぐ。[`top_level_fn`]）。
///
/// 製品の経路のうち固定するのは `configure`（`configure_routes_through_configure_with`）→
/// `configure_with` → `configure_with_backup_exclusion` まで。`run_mobile`・`run_desktop` が
/// `configure` を呼ぶことは固定しない（担保の範囲外）。呼ばれる側の関数の担保の範囲と範囲外は
/// `backup_exclusion_callees_are_single_definitions_without_cfg` の doc に書く（#693）。
#[test]
fn configure_with_passes_the_build_targets_backup_exclusion() {
    let (signature, body) = top_level_fn(&load_lib_rs(), "configure_with");
    assert_eq!(
        signature,
        "pubfnconfigure_with<R:Runtime>(builder:tauri::Builder<R>,secure_state:SecureState)->tauri::Builder<R>",
        "configure_with のシグネチャが変わった（#685。引数・generic を足すと呼び出し側で除外を差し替えられる）"
    );
    assert_eq!(
        body,
        "configure_with_backup_exclusion(builder,secure_state,backup_exclusion_for(EXCLUDES_APP_DATA_FROM_BACKUP))",
        "configure_with の本体が backup_exclusion_for(EXCLUDES_APP_DATA_FROM_BACKUP) を渡す呼び出しだけになっていない（#681・#683）"
    );
}

/// `configure_with` から呼ばれる側の関数が、cfg でターゲットごとに差し替えられていないこと（#693）。
/// ホストの単体テストはホストの定義しか実行できず、`check:ios` はコンパイルしかしないため、
/// `#[cfg(not(target_os = "ios"))]` 付きの元の定義と `#[cfg(target_os = "ios")]` 付きの差し替え
/// （除外を `None` にする等）を並べられると、iOS だけ除外が外れても全テストが通る。そこで
/// 4 つの関数について、定義がちょうど 1 つで、括弧のブロックの中になく、定義の行の `fn` より左が
/// 修飾子だけで、外側の属性に `cfg` が無いことを [`single_top_level_definition`] で照らす。`app_data_backup_exclusion_plugin` は
/// `pub` でない（`pub fn` の確認は含めない）。
///
/// 照らさないもの（残る抜け道を含む）:
/// - 本体の中の cfg（`#[cfg(target_os = "ios")] let exclusion = None;`・`cfg!(..)` による分岐）。
///   照らすのは定義の手前の文面だけで、本体は読まない。`configure_with_backup_exclusion` の
///   本体には正当な `#[cfg(desktop)]` があるため、本体の `cfg` の語を一律には禁じられない。
/// - `cfg` の語を含まない属性マクロ（proc-macro 等）による差し替え。
/// - `exclude_from_backup`: `#[cfg(target_vendor = "apple")]` と `#[cfg(not(target_vendor = "apple"))]`
///   の 2 定義が正当に並ぶ。Apple 側は objc2 の実 API で、ホストの macOS の単体テストが実際に属性が
///   付くことを確かめ、iOS のコンパイルは `check:ios` が確かめる。ただし `check:ios` はコンパイルが
///   通ることしか確かめず、iOS でどちらの定義が選ばれるか（cfg を狭めて iOS だけ別の定義に差し替える
///   形）は固定しない。iOS での実観測は #682。
/// - `EXCLUDES_APP_DATA_FROM_BACKUP`: 関数ではなく、ターゲットごとの `const _: () = assert!(..)` が
///   コンパイルで固定する。
#[test]
fn backup_exclusion_callees_are_single_definitions_without_cfg() {
    let source = load_lib_rs();
    for name in [
        "configure_with_backup_exclusion",
        "backup_exclusion_for",
        "app_data_backup_exclusion_plugin",
        "exclude_app_data_dir_from_backup",
    ] {
        single_top_level_definition(&source, name);
    }
}

/// 製品の `configure` が、製品版の通信層の状態を作って `configure_with` を通ること（#685）。
/// `configure_with` を飛ばして `configure_with_backup_exclusion` を直接呼ぶと、上の照合が
/// 効かない経路で除外を差し替えられるため、同じ方法（定義が 1 つ・cfg 無し・シグネチャと本体の
/// 完全一致）で固定する。
#[test]
fn configure_routes_through_configure_with() {
    let (signature, body) = top_level_fn(&load_lib_rs(), "configure");
    assert_eq!(
        signature,
        "pubfnconfigure<R:Runtime>(builder:tauri::Builder<R>)->tauri::Builder<R>",
        "configure のシグネチャが変わった（#685）"
    );
    assert_eq!(
        body,
        "letsecure_state=SecureState::production().expect(\"failedtobuildthesecuretransport\");configure_with(builder,secure_state)",
        "configure の本体が SecureState::production() を作って configure_with を呼ぶだけになっていない（#685）"
    );
}

/// `gen/apple` のファイルから、`PRODUCT_BUNDLE_IDENTIFIER` の値をすべて取り出す
/// （`project.yml` は `KEY: value`、`project.pbxproj` は `KEY = value;`）。
fn product_bundle_identifiers(relative: &str) -> Vec<String> {
    let path = manifest_dir().join("gen/apple").join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("PRODUCT_BUNDLE_IDENTIFIER"))
        .map(|rest| {
            rest.trim_start_matches([' ', ':', '='])
                .trim_end_matches(';')
                .trim()
                .trim_matches('"')
                .to_string()
        })
        .collect()
}

#[test]
fn xcode_project_bundle_identifier_matches_tauri_conf() {
    let conf = load_tauri_conf();
    let identifier = conf["identifier"]
        .as_str()
        .expect("identifier が文字列でない");
    for file in ["project.yml", "ai-boss-tauri-app.xcodeproj/project.pbxproj"] {
        let found = product_bundle_identifiers(file);
        assert!(
            !found.is_empty(),
            "gen/apple/{file} に PRODUCT_BUNDLE_IDENTIFIER が無い"
        );
        assert!(
            found.iter().all(|value| value == identifier),
            "gen/apple/{file} の PRODUCT_BUNDLE_IDENTIFIER {found:?} が tauri.conf.json の {identifier} と食い違う"
        );
    }
}
