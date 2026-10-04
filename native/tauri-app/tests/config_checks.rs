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

#[test]
fn run_is_the_mobile_entry_point() {
    let path = manifest_dir().join("src/lib.rs");
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
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
