include!("src/app_commands.rs");

fn main() {
    // #581 S3（機能仕様 docs/features/secure-transport-byok.md クリティカル
    // 設計決定 8）: アプリのコマンドを `AppManifest` に列挙し、capability で
    // 個別に許可する（`allow-secure-send` 等）。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
