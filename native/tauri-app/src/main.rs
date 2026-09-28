// Windows でリリースビルド時にコンソールウィンドウを出さない（プラットフォーム差は macOS 版
// では効かないが、標準の Tauri scaffold の作法として残す）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
