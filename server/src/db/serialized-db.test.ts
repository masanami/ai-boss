import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createBetterSqlite3Driver } from "./connection.js";
import { createSerializedDb } from "./serialized-db.js";
import type { DbPort } from "./db-port.js";

/**
 * 契約テスト（#601）。better-sqlite3 ドライバ＋`:memory:` の上で、直列化層
 * （`serialized-db.ts`）のトランザクションの意味（ロールバック・例外の
 * 投げ直し・割り込みの排除・入れ子）を固定する
 * （機能仕様 docs/features/async-db-layer.md AC-2/AC-2b/AC-3/AC-4）。
 */

function createTestPort(): { db: DbPort; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
  const db = createSerializedDb(createBetterSqlite3Driver(raw));
  return { db, raw };
}

/** 外からの解決を制御できる Promise（AC-3 の割り込みの決定的な差し込み用）。
 * 壁時計（setTimeout 等）に頼らず、トランザクション内の await を明示的に
 * 保留し続ける。 */
function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * すでにスケジュール済みのマイクロタスクをすべて片付けてから戻る。ここでの
 * 目的は「別の流れの書き込みがまだ完了していないこと」を確かめる前に、
 * トランザクション側の直列化された処理（`BEGIN`・最初の `run` 等、いずれも
 * マイクロタスク段の処理）を確実に進めておくことだけであり、`deferred` の
 * 解決タイミングという割り込みの本体は依然としてテストが明示的に制御する
 * （壁時計の経過に結果を委ねているわけではない）。
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * self-review（code-reviewer/design-reviewer 双方が独立に指摘・CONFIRMED）
 * のための test double。後始末の文（`ROLLBACK`／`ROLLBACK TO`）を**実際に
 * 内側のドライバへ実行させた上で**、呼び出し元（直列化層）へは例外を返す。
 * これは、SQLite が自身で先にロールバックを済ませてしまった後（
 * `SQLITE_FULL`・`IOERR` 等）に、こちらの明示的な `ROLLBACK`／`ROLLBACK TO`
 * 文が「ロールバックするトランザクションが無い」に類する理由で失敗する、
 * という現実の経路を模す（後始末は実際に完了しているので、以後の操作は
 * 正常に進む）。`sql` が一致するのは最初の1回だけ（無限に失敗し続けない）。
 */
function driverThatFailsOnceAfterRealExec(
  inner: ReturnType<typeof createBetterSqlite3Driver>,
  shouldFail: (sql: string) => boolean,
): ReturnType<typeof createBetterSqlite3Driver> {
  let alreadyFailed = false;
  return {
    run: (sql, params) => inner.run(sql, params),
    get: (sql, params) => inner.get(sql, params),
    all: (sql, params) => inner.all(sql, params),
    async exec(sql: string) {
      await inner.exec(sql);
      if (!alreadyFailed && shouldFail(sql)) {
        alreadyFailed = true;
        throw new Error(`simulated failure after actually executing: ${sql}`);
      }
    },
  };
}

describe("createSerializedDb — 戻り値の受け渡し・基本の入出力", () => {
  it("transaction() は fn の戻り値をそのまま返す", async () => {
    const { db, raw } = createTestPort();

    const result = await db.transaction(async () => "hello");

    expect(result).toBe("hello");
    raw.close();
  });

  it("run() はトランザクション外で changes/lastInsertRowid を number で返す", async () => {
    const { db, raw } = createTestPort();

    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["apple"]);

    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(typeof result.lastInsertRowid).toBe("number");
    raw.close();
  });

  it("get() は該当行が無いとき undefined を返す", async () => {
    const { db, raw } = createTestPort();

    const row = await db.get("SELECT * FROM items WHERE id = ?", [999]);

    expect(row).toBeUndefined();
    raw.close();
  });

  it("all() は該当行が無いとき空配列を返す", async () => {
    const { db, raw } = createTestPort();

    const rows = await db.all("SELECT * FROM items");

    expect(rows).toEqual([]);
    raw.close();
  });
});

describe("createSerializedDb — AC-2: transaction 内の例外でその中の書き込みはすべて残らない", () => {
  it("同期の throw の場合、書き込みはロールバックされる", async () => {
    const { db, raw } = createTestPort();

    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["should-not-remain"]);
        throw new Error("boom (sync throw)");
      }),
    ).rejects.toThrow("boom (sync throw)");

    const rows = await db.all("SELECT * FROM items");
    expect(rows).toEqual([]);

    // `fn` が async でない（Promise を返す前に同期で throw する）場合も
    // ROLLBACK され、BEGIN が開いたまま残らない（開いたままなら次の
    // トップレベルの transaction の BEGIN が失敗する）。
    const syncError = new Error("boom (truly sync throw)");
    await expect(
      db.transaction((): never => {
        throw syncError;
      }),
    ).rejects.toBe(syncError);
    await expect(db.transaction(async (tx) => tx.run("INSERT INTO items (name) VALUES (?)", ["after"]))).resolves.toBeDefined();
    expect(await db.all("SELECT name FROM items")).toEqual([{ name: "after" }]);
    raw.close();
  });

  it("拒否された Promise の場合も、書き込みはロールバックされる", async () => {
    const { db, raw } = createTestPort();

    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["should-not-remain"]);
        await Promise.reject(new Error("boom (rejected promise)"));
      }),
    ).rejects.toThrow("boom (rejected promise)");

    const rows = await db.all("SELECT * FROM items");
    expect(rows).toEqual([]);
    raw.close();
  });
});

describe("createSerializedDb — AC-2b: 投げられた例外はロールバック後も同じオブジェクトのまま伝わる", () => {
  it("fn が投げた例外オブジェクトが toBe で一致する", async () => {
    const { db, raw } = createTestPort();
    const originalError = new Error("distinctive marker error");

    let caught: unknown;
    try {
      await db.transaction(async () => {
        throw originalError;
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalError);
    raw.close();
  });
});

describe("createSerializedDb — AC-3: transaction 実行中の別の流れの書き込みは混ざらず、終わってから実行される", () => {
  it("トランザクション内で await している間に発行された書き込みは、トランザクション終了後に実行される（トランザクションはロールバックしても、その書き込みは残る）", async () => {
    const { db, raw } = createTestPort();
    const deferred = createDeferred<void>();
    const order: string[] = [];

    const txPromise = db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["inside-tx"]);
      order.push("tx:before-await");
      await deferred.promise;
      order.push("tx:after-await");
      throw new Error("rollback the transaction on purpose");
    });

    // 別の流れの書き込みをトランザクションの実行中に発行する。直列化層の
    // ロックにより、トランザクションが終わるまでキューで待たされるはず。
    const concurrentPromise = db.run("INSERT INTO items (name) VALUES (?)", ["concurrent"]).then((result) => {
      order.push("concurrent:done");
      return result;
    });

    // トランザクションが `deferred` を待って止まっている間は、並行の書き込み
    // はまだ完了していないはず。
    await flushMicrotasks();
    expect(order).toEqual(["tx:before-await"]);

    deferred.resolve();

    await expect(txPromise).rejects.toThrow("rollback the transaction on purpose");
    await concurrentPromise;

    // 実行順は「トランザクションの後始末 → 並行の書き込み」。
    expect(order).toEqual(["tx:before-await", "tx:after-await", "concurrent:done"]);

    // トランザクション内の書き込みはロールバックされ、並行の書き込みだけ残る。
    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([{ name: "concurrent" }]);
    raw.close();
  });
});

describe("createSerializedDb — AC-4: 入れ子の transaction で内側だけ例外を投げても外側は続けられる", () => {
  it("内側の書き込みだけ戻り、外側が捕まえて続ければ外側の書き込みはコミットされる", async () => {
    const { db, raw } = createTestPort();

    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-before"]);

      let innerError: unknown;
      try {
        await tx.transaction(async (innerTx) => {
          await innerTx.run("INSERT INTO items (name) VALUES (?)", ["inner-should-not-remain"]);
          throw new Error("inner failure");
        });
      } catch (err) {
        innerError = err;
      }

      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-after"]);
      return innerError;
    });

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("inner failure");

    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([{ name: "outer-before" }, { name: "outer-after" }]);
    raw.close();
  });
});

describe("createSerializedDb — 終了後の tx の使用は例外にする", () => {
  it("transaction() が解決した後に、渡された tx を使うと例外になる", async () => {
    const { db, raw } = createTestPort();
    let capturedTx: Parameters<Parameters<DbPort["transaction"]>[0]>[0] | undefined;

    await db.transaction(async (tx) => {
      capturedTx = tx;
    });

    expect(capturedTx).toBeDefined();
    await expect(capturedTx!.run("INSERT INTO items (name) VALUES (?)", ["late"])).rejects.toThrow(
      /already finished/,
    );
    raw.close();
  });
});

describe("createSerializedDb — 失敗後もロックが解放され次の操作が進む", () => {
  it("失敗した transaction の後でも、次の DB 操作は正常に実行される", async () => {
    const { db, raw } = createTestPort();

    await expect(
      db.transaction(async () => {
        throw new Error("first transaction fails");
      }),
    ).rejects.toThrow("first transaction fails");

    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["after-failure"]);
    expect(result.changes).toBe(1);

    const rows = await db.all<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([{ name: "after-failure" }]);
    raw.close();
  });
});

describe("createSerializedDb — self-review で見つかった回帰: ROLLBACK 自体の失敗", () => {
  it("トップレベル: ROLLBACK 自体が失敗しても、fn が投げた元の例外が同じオブジェクトのまま伝わり、ロックは解放される", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const flakyDriver = driverThatFailsOnceAfterRealExec(
      createBetterSqlite3Driver(raw),
      (sql) => sql === "ROLLBACK",
    );
    const db = createSerializedDb(flakyDriver);
    const originalError = new Error("fn failure (ROLLBACK itself will also fail)");

    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["should-not-remain"]);
        throw originalError;
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(originalError);

    // ROLLBACK は（失敗を報告する前に）実際に実行されているので、書き込みは残らない。
    const rows = await db.all<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([]);

    // ロックは解放され、次の操作は正常に進む。
    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["after-rollback-failure"]);
    expect(result.changes).toBe(1);
    raw.close();
  });

  it("入れ子: ROLLBACK TO 自体が失敗しても、fn が投げた元の例外が同じオブジェクトのまま伝わり、外側は続けられる", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const flakyDriver = driverThatFailsOnceAfterRealExec(createBetterSqlite3Driver(raw), (sql) =>
      sql.startsWith("ROLLBACK TO"),
    );
    const db = createSerializedDb(flakyDriver);
    const originalInnerError = new Error("inner failure (ROLLBACK TO itself will also fail)");

    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-before"]);

      let innerCaught: unknown;
      try {
        await tx.transaction(async (innerTx) => {
          await innerTx.run("INSERT INTO items (name) VALUES (?)", ["inner-should-not-remain"]);
          throw originalInnerError;
        });
      } catch (err) {
        innerCaught = err;
      }

      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-after"]);
      return innerCaught;
    });

    expect(result).toBe(originalInnerError);

    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([{ name: "outer-before" }, { name: "outer-after" }]);
    raw.close();
  });
});

describe("createSerializedDb — self-review で見つかった回帰: 漏れた（await しなかった）入れ子 tx", () => {
  it("外側が確定した後、await されなかった内側の tx を使うと例外になる（ロックの外での書き込みを防ぐ）", async () => {
    const { db, raw } = createTestPort();
    let leakedInnerTx: Parameters<Parameters<DbPort["transaction"]>[0]>[0] | undefined;

    await db.transaction(async (tx) => {
      // 意図的に `await` せずに内側のトランザクションを漏らす。内側の `fn`
      // は解決しない Promise で止まったままなので、外側はこの呼び出しの
      // 完了を待たずに `fn` から返る。
      void tx.transaction(async (innerTx) => {
        leakedInnerTx = innerTx;
        return new Promise<void>(() => {
          /* 意図的に解決しない */
        });
      });
    });

    expect(leakedInnerTx).toBeDefined();
    await expect(
      leakedInnerTx!.run("INSERT INTO items (name) VALUES (?)", ["leaked-write"]),
    ).rejects.toThrow(/already finished/);

    // 漏れた tx からの書き込みは実行されていない。
    const rows = await db.all<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([]);
    raw.close();
  });
});

describe("createSerializedDb — self-review で見つかった回帰: 同じ tx への `busy` 中の呼び出しは即座に例外になる", () => {
  it("同じ tx から2つ目の入れ子トランザクションを、1つ目を await せず並行に張ると、2つ目は「busy」で即座に拒否され、1つ目は正常に完了する（SAVEPOINT を互いに巻き込まない）", async () => {
    const { db, raw } = createTestPort();

    const result = await db.transaction(async (tx) => {
      const [aResult, bResult] = await Promise.allSettled([
        tx.transaction(async (innerA) => {
          await innerA.run("INSERT INTO items (name) VALUES (?)", ["a"]);
          return "a-committed";
        }),
        // `await` せず1つ目と同時に張る。`busy` フラグにより、こちらは
        // ドライバに一切文を発行せず即座に拒否される（キューで待って
        // 後から成功する、ということはしない — 「self-review 2周目」で
        // 見つかったデッドロックの反省: 待たせず即座に失敗させる）。
        tx.transaction(async (innerB) => {
          await innerB.run("INSERT INTO items (name) VALUES (?)", ["b"]);
          return "b-committed";
        }),
      ]);
      return { aResult, bResult };
    });

    expect(result.aResult).toEqual({ status: "fulfilled", value: "a-committed" });
    expect(result.bResult.status).toBe("rejected");
    expect((result.bResult as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((result.bResult as PromiseRejectedResult).reason.message).toMatch(/currently running its own nested/);

    // a はコミットされて残り、b は SAVEPOINT を一切張らずに拒否されたので
    // 書き込みは実行されていない（互いの SAVEPOINT を巻き込んでいない）。
    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([{ name: "a" }]);
    raw.close();
  });

  it("入れ子の fn の中から祖先の tx を呼び返すと、待たされず（固まらず）即座に例外になる", async () => {
    const { db, raw } = createTestPort();

    const result = await db.transaction(async (tx) => {
      let ancestorCallError: unknown;
      await tx.transaction(async () => {
        try {
          // 契約違反: `fn` の中では渡された `tx`（この `fn` の引数）だけを
          // 使うべきで、祖先の `tx` を呼んではいけない（機能仕様・決定1）。
          // 修正前は、これが接続全体を巻き込むデッドロックになっていた。
          await tx.run("INSERT INTO items (name) VALUES (?)", ["should-not-run"]);
        } catch (err) {
          ancestorCallError = err;
        }
      });
      return ancestorCallError;
    });

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/currently running its own nested/);

    const rows = await db.all<{ name: string }>("SELECT name FROM items");
    expect(rows).toEqual([]);
    raw.close();
  });
});
