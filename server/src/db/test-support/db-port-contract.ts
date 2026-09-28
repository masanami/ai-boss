import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbPort } from "../db-port.js";
import { runMigrations } from "../migrate.js";

/**
 * 両版で同じ契約スイート（#580 S2・機能仕様 docs/features/async-db-layer.md
 * 「契約テストを器の上で通す仕組み」・受入基準（S2）AC-S2-13〜21）。
 *
 * テスト専用の補助。ドライバに依存しない — 呼び出し側が「空の DB の上の
 * 直列化済みポート」を開く関数を渡す:
 * - 開発者用の版: better-sqlite3 実装（`:memory:`）。`db-port-contract.test.ts`
 *   （`npm test`）
 * - 製品版: plugin-sql 実装（`@tauri-apps/plugin-sql` → 器の IPC の中継 →
 *   リポジトリ内 fork）。`web/tauri-db/`（`npm run test:tauri-db`）
 *
 * S1 の既存のテスト（`serialized-db.test.ts`・`migrate.test.ts`）は動かさず
 * 残し、ここには両版で同じ本体を回したい契約（原子性・直列化・`user_version`
 * のマイグレーション・`foreign_keys`・値の往復）だけを置く（仮定 A9）。
 */

export interface DbPortContractSubject {
  /** 空の DB の上の、直列化済みの非同期 DB ポート */
  db: DbPort;
  /** テストの後始末（接続・子プロセスを閉じる） */
  close(): Promise<void> | void;
}

/** `migrate.ts` のマイグレーションの最新の版（S1 の時点の 10 に #647 が v11 を足した。S2 は版を足さない） */
const LATEST_SCHEMA_VERSION = 11;

/**
 * 別の流れの書き込みが「まだ終わっていない」ことを確かめる前に待つ時間。
 * 製品版では要求が IPC の中継（子プロセス）を往復するため、マイクロタスクを
 * 流すだけでは足りない。直列化層が止めていなければこの間に届いてしまう長さ
 * にする（止めていれば、どれだけ待っても届かない）。
 */
const INTERLEAVING_WINDOW_MS = 100;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function userVersion(db: DbPort): Promise<number | undefined> {
  const row = await db.get<{ user_version: number }>("PRAGMA user_version");
  return row?.user_version;
}

async function tableExists(db: DbPort, name: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return row?.n === 1;
}

const CREATE_ITEMS = "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)";
const INSERT_ITEM = "INSERT INTO items (name) VALUES (?)";

export function describeDbPortContract(
  driverName: string,
  openEmpty: () => Promise<DbPortContractSubject>,
): void {
  describe(`DB ポートの契約（${driverName}）`, () => {
    let subject: DbPortContractSubject | undefined;
    let db: DbPort;

    beforeEach(async () => {
      subject = await openEmpty();
      db = subject.db;
    });

    afterEach(async () => {
      // `openEmpty` が失敗したときは閉じるものが無い（元の失敗を隠さない）。
      await subject?.close();
      subject = undefined;
    });

    it("AC-S2-13: run は changes と挿入した行の ID を返し、get は該当が無いとき undefined、all は空配列を返す", async () => {
      await db.exec(CREATE_ITEMS);

      expect(await db.run(INSERT_ITEM, ["first"])).toEqual({ changes: 1, lastInsertRowid: 1 });
      expect(await db.run(INSERT_ITEM, ["second"])).toEqual({ changes: 1, lastInsertRowid: 2 });
      expect(await db.run("UPDATE items SET name = ?", ["renamed"])).toMatchObject({ changes: 2 });
      expect(await db.get("SELECT * FROM items WHERE id = ?", [999])).toBeUndefined();
      expect(await db.all("SELECT * FROM items WHERE id = ?", [999])).toEqual([]);
      expect(await db.get("SELECT id, name FROM items WHERE id = ?", [2])).toEqual({
        id: 2,
        name: "renamed",
      });
    });

    it("AC-S2-14: 整数・小数・文字列・null を束縛して書いた値は、読み出すと同じ値に戻る", async () => {
      await db.exec("CREATE TABLE v (i INTEGER, big INTEGER, r REAL, s TEXT, n TEXT)");
      const text = "日本語と 'quote' と \"double\"";

      await db.run("INSERT INTO v (i, big, r, s, n) VALUES (?, ?, ?, ?, ?)", [
        -42,
        1_790_000_000_000,
        2.5,
        text,
        null,
      ]);

      expect(await db.get("SELECT i, big, r, s, n FROM v")).toEqual({
        i: -42,
        big: 1_790_000_000_000,
        r: 2.5,
        s: text,
        n: null,
      });
    });

    it("AC-S2-15: exec に渡した複数の文はすべて実行される", async () => {
      await db.exec(`
        CREATE TABLE a (x INTEGER);
        CREATE TABLE b (y INTEGER);
        INSERT INTO a (x) VALUES (1);
        INSERT INTO b (y) VALUES (2);
      `);

      expect(await db.get("SELECT x FROM a")).toEqual({ x: 1 });
      expect(await db.get("SELECT y FROM b")).toEqual({ y: 2 });
    });

    it("AC-S2-16: transaction の中の例外で中の書き込みはすべて残らず、例外は同じオブジェクトのまま伝わる", async () => {
      await db.exec(CREATE_ITEMS);
      const error = new Error("boom");

      await expect(
        db.transaction(async (tx) => {
          await tx.run(INSERT_ITEM, ["first"]);
          await tx.run(INSERT_ITEM, ["second"]);
          throw error;
        }),
      ).rejects.toBe(error);

      expect(await db.all("SELECT * FROM items")).toEqual([]);
    });

    it("AC-S2-17: transaction の実行中に別の流れが発行した書き込みは、トランザクションに入らずロールバックしても残る", async () => {
      await db.exec(CREATE_ITEMS);
      const entered = createDeferred();
      const release = createDeferred();

      const transaction = db.transaction(async (tx) => {
        await tx.run(INSERT_ITEM, ["inside"]);
        entered.resolve();
        // DB 以外の await の間に、別の流れが書き込みを発行する。
        await release.promise;
        throw new Error("roll back the inside write");
      });
      await entered.promise;

      let outsideDone = false;
      const outside = db.run(INSERT_ITEM, ["outside"]).then((result) => {
        outsideDone = true;
        return result;
      });
      await wait(INTERLEAVING_WINDOW_MS);
      expect(outsideDone).toBe(false);

      release.resolve();
      await expect(transaction).rejects.toThrow("roll back the inside write");
      await outside;

      expect(await db.all("SELECT name FROM items")).toEqual([{ name: "outside" }]);
    });

    it("AC-S2-18: 入れ子の transaction の内側の例外を外側が捕まえて続けると、内側だけが戻り外側はコミットされる", async () => {
      await db.exec(CREATE_ITEMS);
      const innerError = new Error("inner");

      await db.transaction(async (tx) => {
        await tx.run(INSERT_ITEM, ["outer-before"]);
        await expect(
          tx.transaction(async (inner) => {
            await inner.run(INSERT_ITEM, ["inner"]);
            throw innerError;
          }),
        ).rejects.toBe(innerError);
        await tx.run(INSERT_ITEM, ["outer-after"]);
      });

      expect(await db.all("SELECT name FROM items ORDER BY id")).toEqual([
        { name: "outer-before" },
        { name: "outer-after" },
      ]);
    });

    it(`AC-S2-19: 空の DB に runMigrations を行うと user_version は ${LATEST_SCHEMA_VERSION} になり、再実行しても変わらない`, async () => {
      await runMigrations(db);
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      await runMigrations(db);
      expect(await userVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    });

    it("AC-S2-20: ある版のマイグレーションが失敗すると、その版の変更は残らず user_version は直前の版のまま", async () => {
      await expect(
        runMigrations(db, {
          1: "CREATE TABLE m1 (x INTEGER)",
          2: "CREATE TABLE m2 (x INTEGER); INSERT INTO no_such_table (x) VALUES (1)",
        }),
      ).rejects.toThrow("migration to version 2 failed");

      expect(await userVersion(db)).toBe(1);
      expect(await tableExists(db, "m1")).toBe(true);
      expect(await tableExists(db, "m2")).toBe(false);
    });

    it("AC-S2-21: マイグレーション後の DB は外部キーを強制する（v4 の foreign_keys の切り替えの後も ON）", async () => {
      await runMigrations(db);

      expect(await db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
      await expect(
        db.run("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)", [
          999_999,
          "user",
          "orphan",
          "2026-09-29T00:00:00.000Z",
        ]),
      ).rejects.toBeDefined();
      expect(await db.all("SELECT * FROM messages")).toEqual([]);
    });
  });
}
