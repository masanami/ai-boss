// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { PluginSqlDatabase } from "./plugin-sql-driver";
import { getProductDatabase, openProductDb, PRODUCT_DB_URL } from "./product-db";

/**
 * 製品版の DB の参照のしかた（#580 S2・機能仕様
 * docs/features/async-db-layer.md AC-S2-9）。DB ファイルを開くのは Rust 側の
 * preload だけで、WebView は `load` を呼ばずに名前で参照する。実際の plugin-sql
 * の上での確認（中継を流れるコマンドに `load` が無い）は `web/tauri-db/`。
 */

describe("getProductDatabase", () => {
  afterEach(() => {
    clearMocks();
    vi.unstubAllGlobals();
  });

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

/**
 * 最初の `ROLLBACK` の失敗の扱い（仮定 A11・A7）。実 SQLite の上で「開いた
 * トランザクションが無い」の文言が届くことは `web/tauri-db/` が担保する
 * （新しい DB で `openProductDb` が通る）。ここでは失敗の種類の振り分けを固定する。
 */
function fakeDatabase(rollbackError: unknown): { database: PluginSqlDatabase; queries: string[] } {
  const queries: string[] = [];
  const database: PluginSqlDatabase = {
    async execute(query) {
      queries.push(query);
      if (query === "ROLLBACK") throw rollbackError;
      return { rowsAffected: 0, lastInsertId: 0 };
    },
    async select<T>(query: string) {
      queries.push(query);
      return (query === "PRAGMA user_version" ? [{ user_version: 0 }] : []) as T;
    },
  };
  return { database, queries };
}

describe("openProductDb の最初の ROLLBACK", () => {
  it("「開いたトランザクションが無い」で失敗したら無視してマイグレーションへ進む", async () => {
    const { database, queries } = fakeDatabase(
      "error returned from database: (code: 1) cannot rollback - no transaction is active",
    );

    await expect(openProductDb(database)).resolves.toBeDefined();

    expect(queries[0]).toBe("ROLLBACK");
    expect(queries).toContain("PRAGMA user_version");
  });

  it("それ以外（IPC の失敗など）で失敗したら DB の準備を失敗させ、以後の文を送らない", async () => {
    const ipcFailure = new Error("IPC の一時的な失敗");
    const { database, queries } = fakeDatabase(ipcFailure);

    await expect(openProductDb(database)).rejects.toBe(ipcFailure);

    expect(queries).toEqual(["ROLLBACK"]);
  });
});
