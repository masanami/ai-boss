/// 器が WebView へ公開するアプリのコマンドの一覧（機能仕様
/// docs/features/secure-transport-byok.md クリティカル設計決定 8・受入基準
/// （S3）S3-C1）。`build.rs` がこの一覧を `tauri_build` の `AppManifest` へ
/// 渡し、コマンドごとに `allow-<名前>` の権限が作られる（capability に書いた
/// ものだけが呼べる）。**キーの値を返すコマンドは置かない**。
///
/// `build.rs` からも `include!` で読むため、このファイルは依存を持たない。
pub const APP_COMMANDS: [&str; 5] = [
    "secure_send",
    "secure_cancel",
    "byok_key_set",
    "byok_key_delete",
    "byok_key_status",
];
