import { ByokKeyCommandError, type ByokKeyManager } from "../byok-key-manager-context";
import type { TauriInvoke } from "./tauri-secure-transport";

/**
 * キーの操作の Tauri 実装（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 8）。器の
 * コマンド `byok_key_set`・`byok_key_delete`・`byok_key_status` を、
 * プロバイダ `anthropic` で呼ぶ。キーの値を返すコマンドは無い。
 */

const PROVIDER = "anthropic";

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

export function createTauriByokKeyManager(invoke: TauriInvoke): ByokKeyManager {
  return {
    async isRegistered() {
      return (await call(invoke, "byok_key_status", { provider: PROVIDER })) === true;
    },
    async register(key) {
      await call(invoke, "byok_key_set", { provider: PROVIDER, key });
    },
    async remove() {
      await call(invoke, "byok_key_delete", { provider: PROVIDER });
    },
  };
}
