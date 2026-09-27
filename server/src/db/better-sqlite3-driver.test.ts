import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createBetterSqlite3Driver, createBetterSqlite3Port } from "./better-sqlite3-driver.js";

function openTestDb() {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  return raw;
}

// `DbDriver` の契約（`db-port.ts`）は同期・非同期どちらの実装も許すため
// （戻り値は `T | Promise<T>`）、ここでは `await` して契約どおりに使う
// （実際の better-sqlite3 実装は同期だが、その実装詳細に依存しない）。
describe("createBetterSqlite3Driver", () => {
  it("run() returns changes and lastInsertRowid as a number (not bigint)", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);

    const result = await driver.run("INSERT INTO items (name) VALUES (?)", ["apple"]);

    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(1);
    expect(typeof result.lastInsertRowid).toBe("number");

    raw.close();
  });

  it("get() returns undefined when no row matches", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);

    const row = await driver.get<{ id: number; name: string }>("SELECT * FROM items WHERE id = ?", [999]);

    expect(row).toBeUndefined();

    raw.close();
  });

  it("get() returns the matching row", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);
    await driver.run("INSERT INTO items (name) VALUES (?)", ["banana"]);

    const row = await driver.get<{ id: number; name: string }>("SELECT * FROM items WHERE name = ?", ["banana"]);

    expect(row).toEqual({ id: 1, name: "banana" });

    raw.close();
  });

  it("all() returns an empty array when no rows match", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);

    const rows = await driver.all("SELECT * FROM items");

    expect(rows).toEqual([]);

    raw.close();
  });

  it("all() returns every matching row", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);
    await driver.run("INSERT INTO items (name) VALUES (?)", ["apple"]);
    await driver.run("INSERT INTO items (name) VALUES (?)", ["banana"]);

    const rows = await driver.all<{ id: number; name: string }>("SELECT * FROM items ORDER BY id");

    expect(rows).toEqual([
      { id: 1, name: "apple" },
      { id: 2, name: "banana" },
    ]);

    raw.close();
  });

  it("exec() runs parameter-less multi-statement SQL", async () => {
    const raw = openTestDb();
    const driver = createBetterSqlite3Driver(raw);

    await driver.exec(`
      INSERT INTO items (name) VALUES ('a');
      INSERT INTO items (name) VALUES ('b');
    `);

    const rows = await driver.all("SELECT * FROM items");
    expect(rows).toHaveLength(2);

    raw.close();
  });
});

/** 外からの解決を制御できる Promise（下記の割り込みの決定的な差し込み用）。 */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createBetterSqlite3Port — self-review で見つかった回帰: raw ごとに同じロックを返す", () => {
  it("同じ raw に対しては、呼び出すたびに同じ DbPort（同じロック）を返す", () => {
    const raw = openTestDb();

    const portA = createBetterSqlite3Port(raw);
    const portB = createBetterSqlite3Port(raw);

    expect(portB).toBe(portA);
    raw.close();
  });

  it("異なる raw に対しては、別々の DbPort（別々のロック）を返す", () => {
    const rawA = openTestDb();
    const rawB = openTestDb();

    const portA = createBetterSqlite3Port(rawA);
    const portB = createBetterSqlite3Port(rawB);

    expect(portA).not.toBe(portB);
    rawA.close();
    rawB.close();
  });

  it("2回目の呼び出しで得たポートも、1回目のポートが握っている直列化ロックを共有する（キャッシュを外すと2本のロックができ、この待ち合わせが起きなくなる）", async () => {
    const raw = openTestDb();
    const firstCallPort = createBetterSqlite3Port(raw);
    const deferred = createDeferred<void>();
    const order: string[] = [];

    const txPromise = firstCallPort.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["inside-tx"]);
      order.push("tx:before-await");
      await deferred.promise;
      order.push("tx:after-await");
    });

    // `createBetterSqlite3Port` を同じ raw で再度呼び出し、その戻り値
    // （2回目の呼び出しで得たポート）で操作を発行する。1回目の呼び出しが
    // 保持しているのと同じロックを共有していれば、トランザクションが
    // 終わるまでこの操作は待たされるはず。
    const secondCallPort = createBetterSqlite3Port(raw);
    const concurrentPromise = secondCallPort.run("INSERT INTO items (name) VALUES (?)", ["concurrent"]).then(() => {
      order.push("concurrent:done");
    });

    await flushMicrotasks();
    expect(order).toEqual(["tx:before-await"]);

    deferred.resolve();
    await txPromise;
    await concurrentPromise;

    expect(order).toEqual(["tx:before-await", "tx:after-await", "concurrent:done"]);
    raw.close();
  });
});
