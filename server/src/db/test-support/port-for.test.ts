import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { portFor, rawOf } from "./port-for.js";

function openTestDb() {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  return raw;
}

describe("portFor", () => {
  it("returns a working DbPort backed by the given raw connection", async () => {
    const raw = openTestDb();

    const db = portFor(raw);
    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["apple"]);

    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
    raw.close();
  });

  it("returns the same port instance for the same raw connection", () => {
    const raw = openTestDb();

    const first = portFor(raw);
    const second = portFor(raw);

    expect(first).toBe(second);
    raw.close();
  });

  it("returns different port instances for different raw connections", () => {
    const rawA = openTestDb();
    const rawB = openTestDb();

    const portA = portFor(rawA);
    const portB = portFor(rawB);

    expect(portA).not.toBe(portB);
    rawA.close();
    rawB.close();
  });
});

describe("rawOf", () => {
  it("resolves the underlying raw connection from a DbPort created via portFor", () => {
    const raw = openTestDb();
    const db = portFor(raw);

    expect(rawOf(db)).toBe(raw);
    raw.close();
  });

  it("resolves the underlying raw connection from a DbTx inside a transaction", async () => {
    const raw = openTestDb();
    const db = portFor(raw);

    await db.transaction(async (tx) => {
      expect(rawOf(tx)).toBe(raw);
    });
    raw.close();
  });

  it("resolves the underlying raw connection from a nested DbTx", async () => {
    const raw = openTestDb();
    const db = portFor(raw);

    await db.transaction(async (tx) => {
      await tx.transaction(async (innerTx) => {
        expect(rawOf(innerTx)).toBe(raw);
      });
    });
    raw.close();
  });

  it("throws for a Db-shaped object that was not obtained via portFor", () => {
    const raw = openTestDb();
    const orphanPort = { run: async () => ({ changes: 0, lastInsertRowid: 0 }) } as unknown as Parameters<
      typeof rawOf
    >[0];

    expect(() => rawOf(orphanPort)).toThrow();
    raw.close();
  });
});

describe("portFor + rawOf — 同期コードをトランザクション中に呼ぶ移行期の用途", () => {
  it("rawOf(tx) で取り出した生の接続への同期の書き込みは、そのトランザクションに含まれる", async () => {
    const raw = openTestDb();
    const db = portFor(raw);

    await expect(
      db.transaction(async (tx) => {
        // 同じ接続上ですでに BEGIN 済みなので、この同期の書き込みは
        // トランザクションに含まれる（移行期の橋渡しの用途・機能仕様
        // docs/features/async-db-layer.md「移行期の共通規約」）。
        rawOf(tx).prepare("INSERT INTO items (name) VALUES (?)").run("via-raw");
        throw new Error("rollback on purpose");
      }),
    ).rejects.toThrow("rollback on purpose");

    const rows = await db.all("SELECT * FROM items");
    expect(rows).toEqual([]);
    raw.close();
  });
});
