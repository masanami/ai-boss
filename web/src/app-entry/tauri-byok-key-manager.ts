import { ByokKeyCommandError, type ByokKeyManager } from "../byok-key-manager-context";
import type { TauriInvoke } from "./tauri-secure-transport";

/**
 * キーの操作の Tauri 実装（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 8）。器の
 * コマンド `byok_key_set`・`byok_key_delete`・`byok_key_status` を、
 * プロバイダ（`anthropic`〔既定〕・`openai`。#582 S2）で呼ぶ。キーの値を返す
 * コマンドは無い。プロバイダごとに 1 つずつ作る（欄ごとに対応するプロバイダで
 * コマンドを呼ぶ——キーの取り違えを塞ぐ）。
 */

export type ByokProvider = "anthropic" | "openai";

function toKeyCommandError(error: unknown): ByokKeyCommandError {
  if (typeof error === "object" && error !== null) {
    const { kind, osStatus } = error as { kind?: unknown; osStatus?: unknown };
    if (typeof kind === "string") {
      return new ByokKeyCommandError(kind, typeof osStatus === "number" ? osStatus : undefined);
    }
  }
  return new ByokKeyCommandError("unknown");
}

async function call(invoke: TauriInvoke, command: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await invoke(command, args);
  } catch (error) {
    throw toKeyCommandError(error);
  }
}

export function createTauriByokKeyManager(
  invoke: TauriInvoke,
  provider: ByokProvider = "anthropic",
): ByokKeyManager {
  return {
    async isRegistered() {
      return (await call(invoke, "byok_key_status", { provider })) === true;
    },
    async register(key) {
      await call(invoke, "byok_key_set", { provider, key });
    },
    async remove() {
      await call(invoke, "byok_key_delete", { provider });
    },
  };
}
