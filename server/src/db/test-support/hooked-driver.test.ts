import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createBetterSqlite3Driver } from "../better-sqlite3-driver.js";
import { createSerializedDb } from "../serialized-db.js";
import { createHookedDriver } from "./hooked-driver.js";
import type { DbPort } from "../db-port.js";

function openTestDb() {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  return raw;
}

describe("createHookedDriver", () => {
  it("fires the hook after a matching SQL statement runs, and passes results through unchanged", async () => {
    const raw = openTestDb();
    const inner = createBetterSqlite3Driver(raw);
    const fired: string[] = [];
    const driver = createHookedDriver(inner, [
      {
        matches: (sql) => sql.includes("SELECT"),
        after: () => {
          fired.push("after-select");
        },
      },
    ]);

    const insertResult = await driver.run("INSERT INTO items (name) VALUES (?)", ["apple"]);
    expect(insertResult).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(fired).toEqual([]);

    const row = await driver.get<{ name: string }>("SELECT name FROM items WHERE id = ?", [1]);
    expect(row).toEqual({ name: "apple" });
    expect(fired).toEqual(["after-select"]);

    raw.close();
  });

  it("does not fire for non-matching SQL", async () => {
    const raw = openTestDb();
    const inner = createBetterSqlite3Driver(raw);
    const fired: string[] = [];
    const driver = createHookedDriver(inner, [
      {
        matches: (sql) => sql.includes("DELETE"),
        after: () => {
          fired.push("after-delete");
        },
      },
    ]);

    await driver.run("INSERT INTO items (name) VALUES (?)", ["apple"]);

    expect(fired).toEqual([]);
    raw.close();
  });

  it("an operation queued by the hook on the same serialized port waits until the current transaction finishes (used for deterministic interruption tests like AC-19/AC-20)", async () => {
    const raw = openTestDb();
    const inner = createBetterSqlite3Driver(raw);
    const order: string[] = [];
    // フック定義の時点ではまだ `hookedDb` を作れない（`hookedDriver` が先に
    // 要る）ため、後から埋める箱に入れておく（`let` の再代入無しで済ませる
    // ための入れ物。中身は1回だけ埋める）。
    const dbHolder: { current?: DbPort } = {};
    let queuedOpDone: Promise<void> | undefined;
    let hookFired = false;

    const hookedDriver = createHookedDriver(inner, [
      {
        // 最初の SELECT（判定の読み出し）だけに1回だけ差し込む。テストの
        // 最後に結果を検証するための SELECT でも再度発火してしまうと、
        // その2回目の割り込みが待ち合わされないまま残ってしまう。
        matches: (sql) => sql.startsWith("SELECT") && !hookFired,
        after: () => {
          hookFired = true;
          // フック自身は、割り込ませたい別の流れの完了を待たない（await
          // すると直列化層のロックの解放待ちで固まる — トランザクションの
          // 実行そのものがこのフックの呼び出し元だから）。起動だけしてすぐ
          // 返す。
          queuedOpDone = dbHolder.current!.run("INSERT INTO items (name) VALUES (?)", ["from-hook"]).then(() => {
            order.push("concurrent:done");
          });
        },
      },
    ]);
    const hookedDb = createSerializedDb(hookedDriver);
    dbHolder.current = hookedDb;

    // トランザクションは意図的にロールバックさせる。フックが起動した書き込みが
    // トランザクションに混ざっていれば一緒に消えるので、行が残ることで
    // 「トランザクションの外で、終わってから実行された」ことを確かめる
    // （コミットで終わらせると、混ざっていても行が残り検出力が無い）。
    const rollbackMarker = new Error("rollback on purpose");
    await expect(
      hookedDb.transaction(async (tx) => {
        await tx.get("SELECT * FROM items");
        order.push("tx:after-read");
        throw rollbackMarker;
      }),
    ).rejects.toBe(rollbackMarker);

    await queuedOpDone;

    // フックが起動した書き込みは、直列化層の同じロックにキューイングされて
    // いるため、トランザクションが確定するより前には終わり得ない。
    expect(order).toEqual(["tx:after-read", "concurrent:done"]);

    const rows = await hookedDb.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([{ name: "from-hook" }]);

    raw.close();
  });
});
