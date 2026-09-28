// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPluginSqlDriver, type PluginSqlDatabase } from "./plugin-sql-driver";

/**
 * plugin-sql 実装のドライバの写像（#580 S2）。plugin-sql の `Database` は
 * 差し替える — 実際の plugin-sql（器の IPC の中継・fork）の上で同じ契約を
 * 回すのは `web/tauri-db/`（`npm run test:tauri-db`）。
 */
function fakeDatabase(overrides: Partial<PluginSqlDatabase> = {}): PluginSqlDatabase {
  return {
    execute: vi.fn(async () => ({ rowsAffected: 0, lastInsertId: 0 })),
    select: vi.fn(async () => [] as never),
    ...overrides,
  };
}

describe("createPluginSqlDriver", () => {
  it("run は execute に文と位置パラメータを渡し、rowsAffected/lastInsertId を changes/lastInsertRowid で返す", async () => {
    const database = fakeDatabase({ execute: vi.fn(async () => ({ rowsAffected: 3, lastInsertId: 7 })) });

    const result = await createPluginSqlDriver(database).run("UPDATE t SET a = ? WHERE b = ?", [1, "x"]);

    expect(database.execute).toHaveBeenCalledWith("UPDATE t SET a = ? WHERE b = ?", [1, "x"]);
    expect(result).toEqual({ changes: 3, lastInsertRowid: 7 });
  });

  it("run は lastInsertId が返らないとき lastInsertRowid を 0 にする", async () => {
    const database = fakeDatabase({ execute: vi.fn(async () => ({ rowsAffected: 1 })) });

    expect(await createPluginSqlDriver(database).run("DELETE FROM t")).toEqual({ changes: 1, lastInsertRowid: 0 });
    expect(database.execute).toHaveBeenCalledWith("DELETE FROM t", []);
  });

  it("get は select の最初の行を返し、行が無いとき undefined を返す", async () => {
    const rows = [[{ id: 1 }, { id: 2 }], []];
    const database = fakeDatabase({ select: vi.fn(async () => rows.shift() as never) });
    const driver = createPluginSqlDriver(database);

    expect(await driver.get("SELECT id FROM t WHERE a = ?", [1])).toEqual({ id: 1 });
    expect(await driver.get("SELECT id FROM t")).toBeUndefined();
    expect(database.select).toHaveBeenNthCalledWith(1, "SELECT id FROM t WHERE a = ?", [1]);
    expect(database.select).toHaveBeenNthCalledWith(2, "SELECT id FROM t", []);
  });

  it("all は select の行をすべて返す", async () => {
    const database = fakeDatabase({ select: vi.fn(async () => [{ id: 1 }, { id: 2 }] as never) });

    expect(await createPluginSqlDriver(database).all("SELECT id FROM t")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("exec はパラメータ無しで execute に渡す", async () => {
    const database = fakeDatabase();

    await createPluginSqlDriver(database).exec("PRAGMA foreign_keys = ON");

    expect(database.execute).toHaveBeenCalledWith("PRAGMA foreign_keys = ON");
  });
});
