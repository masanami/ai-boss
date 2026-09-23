import { invoke } from "@tauri-apps/api/core";

// 項目 5: Rust 側の security-framework（kSecClassGenericPassword）経由で iOS キーチェーンに保存・読み出し。
export const keychainSet = (value: string) => invoke<void>("keychain_set", { value });
export const keychainGet = () => invoke<string | null>("keychain_get");
export const keychainDelete = () => invoke<void>("keychain_delete");

export async function runKeychainCheck() {
  const fromEnv = await invoke<boolean>("bootstrap_key_from_env");
  const stored = await keychainGet();
  // 値そのものは記録しない（存在と長さ・接頭辞の形だけ）
  return { ok: stored !== null, bootstrappedFromEnvThisLaunch: fromEnv, present: stored !== null, length: stored?.length ?? 0, looksLikeAnthropicKey: stored?.startsWith("sk-ant-") ?? false };
}
