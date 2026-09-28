// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { getProductDatabase, PRODUCT_DB_URL } from "./product-db";

/**
 * 製品版の DB の参照のしかた（#580 S2・機能仕様
 * docs/features/async-db-layer.md AC-S2-9）。DB ファイルを開くのは Rust 側の
 * preload だけで、WebView は `load` を呼ばずに名前で参照する。実際の plugin-sql
 * の上での確認（中継を流れるコマンドに `load` が無い）は `web/tauri-db/`。
 */

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
});

describe("getProductDatabase", () => {
  it("DB を sqlite:ai-boss.db の名前で参照し、IPC（load を含む）を呼ばない", () => {
    vi.stubGlobal("window", globalThis);
    const handler = vi.fn();
    mockIPC(handler);

    const database = getProductDatabase() as unknown as { path: string };

    expect(PRODUCT_DB_URL).toBe("sqlite:ai-boss.db");
    expect(database.path).toBe("sqlite:ai-boss.db");
    expect(handler).not.toHaveBeenCalled();
  });
});
