//! Android の器の設定と依存の検査（#674 S1・機能仕様 `docs/features/android-shell.md`
//! 受入基準（S1）「`gen/android`」「TLS」・決定 6・決定 7）。
//!
//! 実ファイル（`gen/android/app/build.gradle.kts`・`tauri.conf.json`・
//! `native/secure-transport/Cargo.toml`）を読み、依存の木は `cargo tree` に問い合わせる。
//! Android の道具（SDK・NDK）は使わない（`cargo tree` は Cargo.lock と依存のメタデータだけを読む）。

use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: PathBuf) -> String {
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

// --- gen/android -------------------------------------------------------------

/// `build.gradle.kts` の `applicationId = "<値>"` の値（1 か所だけあること）。
fn application_ids(gradle: &str) -> Vec<String> {
    gradle
        .lines()
        .filter_map(|line| line.trim().strip_prefix("applicationId"))
        .filter_map(|rest| rest.trim().strip_prefix('='))
        .map(|value| value.trim().trim_matches('"').to_owned())
        .collect()
}

#[test]
fn gen_android_application_id_matches_the_tauri_identifier() {
    let conf: serde_json::Value =
        serde_json::from_str(&read(manifest_dir().join("tauri.conf.json")))
            .expect("tauri.conf.json");
    let identifier = conf["identifier"].as_str().expect("identifier");
    assert_eq!(identifier, "dev.aiboss.app");
    let gradle = read(manifest_dir().join("gen/android/app/build.gradle.kts"));
    assert_eq!(application_ids(&gradle), vec![identifier.to_owned()]);
}

/// `build.gradle.kts` の `<名前> = <整数>` の値。
fn gradle_ints(gradle: &str, name: &str) -> Vec<u32> {
    gradle
        .lines()
        .filter_map(|line| line.trim().strip_prefix(name))
        .filter_map(|rest| rest.trim().strip_prefix('='))
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

#[test]
fn gen_android_targets_the_sdk_platform_of_the_spec_preparation() {
    // 仕様の準備は platform android-36 を入れる。開発機の SDK の最新に依存させない。
    let gradle = read(manifest_dir().join("gen/android/app/build.gradle.kts"));
    assert_eq!(gradle_ints(&gradle, "compileSdk"), vec![36]);
    assert_eq!(gradle_ints(&gradle, "targetSdk"), vec![36]);
    assert_eq!(gradle_ints(&gradle, "minSdk"), vec![24]);
}

#[test]
fn application_ids_reads_the_gradle_assignment() {
    assert_eq!(
        application_ids("    applicationId = \"a.b.c\"\n    minSdk = 24\n"),
        vec!["a.b.c".to_owned()]
    );
    assert!(application_ids("    namespace = \"a.b.c\"\n").is_empty());
}

// --- secure-transport の依存の表（決定 6・オーナーの申し送り） ----------------------

fn secure_transport_manifest() -> toml::Value {
    toml::from_str(&read(manifest_dir().join("../secure-transport/Cargo.toml")))
        .expect("secure-transport Cargo.toml")
}

fn dependency<'a>(
    manifest: &'a toml::Value,
    table: &[&str],
    name: &str,
) -> Option<&'a toml::Value> {
    let mut value = manifest;
    for key in table {
        value = value.get(key)?;
    }
    value.get(name)
}

fn features(dep: &toml::Value) -> Vec<&str> {
    dep.get("features")
        .and_then(toml::Value::as_array)
        .map(|features| features.iter().filter_map(toml::Value::as_str).collect())
        .unwrap_or_default()
}

const APPLE: [&str; 3] = ["target", "cfg(target_vendor = \"apple\")", "dependencies"];
const ANDROID: [&str; 3] = ["target", "cfg(target_os = \"android\")", "dependencies"];

#[test]
fn the_common_reqwest_has_no_tls_feature_and_no_default_features() {
    // 共通の表に TLS の機能があると、Android でも native-tls（OpenSSL）が有効のまま残る。
    let manifest = secure_transport_manifest();
    let reqwest = dependency(&manifest, &["dependencies"], "reqwest").expect("reqwest");
    assert_eq!(
        reqwest
            .get("default-features")
            .and_then(toml::Value::as_bool),
        Some(false)
    );
    assert!(features(reqwest).is_empty(), "{:?}", features(reqwest));
}

#[test]
fn apple_targets_keep_default_tls() {
    let manifest = secure_transport_manifest();
    let reqwest = dependency(&manifest, &APPLE, "reqwest").expect("apple reqwest");
    assert_eq!(features(reqwest), vec!["default-tls"]);
    assert_eq!(
        reqwest
            .get("default-features")
            .and_then(toml::Value::as_bool),
        Some(false)
    );
}

#[test]
fn android_uses_rustls_with_the_bundled_webpki_roots() {
    let manifest = secure_transport_manifest();
    let reqwest = dependency(&manifest, &ANDROID, "reqwest").expect("android reqwest");
    assert_eq!(features(reqwest), vec!["rustls-tls-webpki-roots"]);
    assert_eq!(
        reqwest
            .get("default-features")
            .and_then(toml::Value::as_bool),
        Some(false)
    );
}

#[test]
fn zeroize_is_a_common_dependency_because_transport_uses_it_on_every_target() {
    // transport.rs は `zeroize::Zeroizing` を無条件で使う（#679 のオーナーの申し送り）。
    let manifest = secure_transport_manifest();
    assert!(dependency(&manifest, &["dependencies"], "zeroize").is_some());
    assert!(dependency(&manifest, &APPLE, "zeroize").is_none());
}

// --- 依存の木（受入基準（S1）「TLS」。`cargo tree -e normal -i <パッケージ>`） ------------

/// `cargo tree` の出力に `<パッケージ> v` で始まる行があるか（`did not match any packages`・
/// `nothing to print` は「出ない」と読む）。
fn tree_has(target: &str, package: &str) -> bool {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
    let output = Command::new(cargo)
        .args(["tree", "--manifest-path"])
        .arg(manifest_dir().join("Cargo.toml"))
        .args(["--target", target, "-e", "normal", "-i", package])
        .output()
        .expect("cargo tree");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let found = stdout
        .lines()
        .any(|line| line.starts_with(&format!("{package} v")));
    assert!(
        found || output.status.success() || stderr.contains("did not match any packages"),
        "cargo tree failed for {target} {package}: {stderr}"
    );
    found
}

#[test]
fn android_tree_has_rustls_and_no_openssl_sys() {
    assert!(!tree_has("aarch64-linux-android", "openssl-sys"));
    assert!(tree_has("aarch64-linux-android", "rustls"));
}

#[test]
fn macos_tree_keeps_native_tls_and_has_no_rustls() {
    assert!(!tree_has("aarch64-apple-darwin", "rustls"));
    assert!(tree_has("aarch64-apple-darwin", "native-tls"));
}

#[test]
fn ios_tree_keeps_native_tls_and_has_no_rustls() {
    assert!(!tree_has("aarch64-apple-ios", "rustls"));
    assert!(tree_has("aarch64-apple-ios", "native-tls"));
}
