use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};
use tauri::Manager;

const KEYCHAIN_SERVICE: &str = "dev.aiboss.spike.tauri";
const KEYCHAIN_ACCOUNT: &str = "anthropic-api-key";

/// 項目 5: BYOK の API キーを iOS キーチェーン（kSecClassGenericPassword）へ保存する。
#[tauri::command]
fn keychain_set(value: String) -> Result<(), String> {
    set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, value.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get() -> Result<Option<String>, String> {
    match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_delete() -> Result<(), String> {
    match delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 自動検証用: `SIMCTL_CHILD_ANTHROPIC_API_KEY` で渡されたキーがあればキーチェーンへ移す。
/// キーの値は JS へ返さない（保存できたかだけ返す）。画面入力の代替で、シミュレータ検証専用。
#[tauri::command]
fn bootstrap_key_from_env() -> Result<bool, String> {
    match std::env::var("ANTHROPIC_API_KEY") {
        Ok(v) if !v.is_empty() => keychain_set(v).map(|_| true),
        _ => Ok(false),
    }
}

/// 自動検証モード（`SIMCTL_CHILD_SPIKE_SELFTEST=<steps>`）。未指定なら空文字。
#[tauri::command]
fn selftest_steps() -> String {
    std::env::var("SPIKE_SELFTEST").unwrap_or_default()
}

/// 検証結果をアプリのデータディレクトリへ書き出す（`xcrun simctl get_app_container` で回収する）。
#[tauri::command]
fn write_report(app: tauri::AppHandle, name: String, text: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            keychain_set,
            keychain_get,
            keychain_delete,
            bootstrap_key_from_env,
            selftest_steps,
            write_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
