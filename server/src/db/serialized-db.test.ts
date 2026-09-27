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
  it("トップレベル: ROLLBACK 自体が失敗すると、fn が投げた元の例外が同じオブジェクトのまま伝わり、ロックは解放されるが、以後このポートは使用不可になる（#617: 後始末が実際に効いたかは判別できないため一律に使用不可へ倒す）", async () => {
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

    // ROLLBACK は（失敗を報告する前に）実際に実行されているので、書き込みは
    // 生の接続で確認しても残らない。
    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });

    // ロックは解放されている（次の操作は固まらず、即座に決着する）が、
    // ROLLBACK 失敗後は使用不可になっているため、この操作は例外になる。
    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after-rollback-failure"])).rejects.toThrow(
      /unusable/,
    );
    raw.close();
  });

  it("入れ子: ROLLBACK TO 自体が失敗しても、fn が投げた元の例外が同じオブジェクトのまま伝わる（外側はコミットされない — PR #615 Codex 指摘で、後始末の成否を判別できない以上は安全側に倒す）", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const flakyDriver = driverThatFailsOnceAfterRealExec(createBetterSqlite3Driver(raw), (sql) =>
      sql.startsWith("ROLLBACK TO"),
    );
    const db = createSerializedDb(flakyDriver);
    const originalInnerError = new Error("inner failure (ROLLBACK TO itself will also fail)");

    let innerCaught: unknown;
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-before"]);
        try {
          await tx.transaction(async (innerTx) => {
            await innerTx.run("INSERT INTO items (name) VALUES (?)", ["inner-should-not-remain"]);
            throw originalInnerError;
          });
        } catch (err) {
          innerCaught = err;
        }
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(innerCaught).toBe(originalInnerError);

    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([]);
    raw.close();
  });
});

/**
 * PR #615 の Codex レビュー（P2）のための test double。`shouldReject(sql)` が
 * 真になる文を、内側のドライバへ**渡さずに**（＝実行前に）拒否する。
 * `driverThatFailsOnceAfterRealExec` と違い、後始末は実際には行われない。
 */
function driverThatRejectsBeforeExec(
  inner: ReturnType<typeof createBetterSqlite3Driver>,
  shouldReject: (sql: string) => boolean,
): ReturnType<typeof createBetterSqlite3Driver> {
  return {
    run: (sql, params) => inner.run(sql, params),
    get: (sql, params) => inner.get(sql, params),
    all: (sql, params) => inner.all(sql, params),
    async exec(sql: string) {
      if (shouldReject(sql)) {
        throw new Error(`simulated rejection before executing: ${sql}`);
      }
      await inner.exec(sql);
    },
  };
}

/**
 * #617 のテスト用。`run`/`get`/`all`/`exec` のどれであっても、`inner` に渡さ
 * れた（＝ `createSerializedDb` の層を通り抜けてドライバまで届いた）呼び出し
 * を `"<メソッド名>: <sql>"` の形で記録する。「ポートが使用不可になった後は
 * `run`/`get`/`all`/`exec` のどのメソッドも（`BEGIN` すら）ドライバへ渡らない
 * （＝判定がドライバに触れる前に排他区間の内側で完結する）」ことを、`exec`
 * だけでなく4メソッドすべてについて確認するために使う（self-review・
 * code-reviewer 指摘・CONFIRMED: 当初は `exec` だけを記録していたため、
 * `get`/`all` の判定がドライバ呼び出しの後ろへ動いても検出できなかった）。
 */
function driverWithExecLog(
  inner: ReturnType<typeof createBetterSqlite3Driver>,
): { driver: ReturnType<typeof createBetterSqlite3Driver>; execLog: string[] } {
  const execLog: string[] = [];
  return {
    driver: {
      run: (sql, params) => {
        execLog.push(`run: ${sql}`);
        return inner.run(sql, params);
      },
      get: (sql, params) => {
        execLog.push(`get: ${sql}`);
        return inner.get(sql, params);
      },
      all: (sql, params) => {
        execLog.push(`all: ${sql}`);
        return inner.all(sql, params);
      },
      async exec(sql: string) {
        execLog.push(`exec: ${sql}`);
        await inner.exec(sql);
      },
    },
    execLog,
  };
}

describe("createSerializedDb — PR #615 Codex 指摘: ROLLBACK TO が実行前に拒否されたら外側をコミットさせない", () => {
  it("内側の元の例外は同じオブジェクトのまま伝わり、外側の transaction は例外で終わって、内側・外側どちらの書き込みも残らない", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql.startsWith("ROLLBACK TO")),
    );
    const originalInnerError = new Error("inner failure (ROLLBACK TO will be rejected before executing)");

    let innerCaught: unknown;
    let outerCaught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-before"]);
        try {
          await tx.transaction(async (innerTx) => {
            await innerTx.run("INSERT INTO items (name) VALUES (?)", ["inner-should-not-remain"]);
            throw originalInnerError;
          });
        } catch (err) {
          innerCaught = err;
        }
        return "outer-returned-normally";
      });
    } catch (err) {
      outerCaught = err;
    }

    expect(innerCaught).toBe(originalInnerError);
    expect(outerCaught).toBeInstanceOf(Error);
    expect(outerCaught).not.toBe(originalInnerError);

    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([]);

    // ロックは解放され、次の操作は正常に進む。
    const result = await db.run("INSERT INTO items (name) VALUES (?)", ["after"]);
    expect(result.changes).toBe(1);
    raw.close();
  });

  it("後始末に失敗した後で外側の tx を使い続けると、その操作は即座に例外になる（オートコミットへ漏らさない）", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql.startsWith("ROLLBACK TO")),
    );

    let continueError: unknown;
    await expect(
      db.transaction(async (tx) => {
        await tx
          .transaction(async (innerTx) => {
            await innerTx.run("INSERT INTO items (name) VALUES (?)", ["inner-should-not-remain"]);
            throw new Error("inner failure");
          })
          .catch(() => undefined);
        try {
          await tx.run("INSERT INTO items (name) VALUES (?)", ["outer-after-should-not-remain"]);
        } catch (err) {
          continueError = err;
        }
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(continueError).toBeInstanceOf(Error);
    const rows = await db.all<{ name: string }>("SELECT name FROM items ORDER BY id");
    expect(rows).toEqual([]);
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

describe("createSerializedDb — #617: トップレベルの ROLLBACK が実行前に拒否されたらポート全体を使用不可にする", () => {
  it("(a) 元の例外は同じオブジェクトのまま伝わり、以後の run/get/all/exec/transaction はすべてドライバに触れず（BEGIN も打たず）即座に拒否され、放置されたトランザクションに書き込みは混ざらない", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const { driver, execLog } = driverWithExecLog(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql === "ROLLBACK"),
    );
    const db = createSerializedDb(driver);
    const originalError = new Error("fn failure (top-level ROLLBACK will be rejected before executing)");

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

    // ドライバは ROLLBACK を実行前に拒否したので、SQLite 側のトランザクション
    // は開いたまま残っている（後始末できていない）。
    expect(raw.inTransaction).toBe(true);

    // ここまでのログ（BEGIN IMMEDIATE・INSERT・ROLLBACK の試行）をクリアし、
    // 以後の呼び出しでドライバに何も渡らないことを確認する。
    execLog.length = 0;

    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after"])).rejects.toThrow(/unusable/);
    await expect(db.get("SELECT * FROM items")).rejects.toThrow(/unusable/);
    await expect(db.all("SELECT * FROM items")).rejects.toThrow(/unusable/);
    await expect(db.exec("SELECT 1")).rejects.toThrow(/unusable/);
    await expect(db.transaction(async () => "should-not-run")).rejects.toThrow(/unusable/);

    // 使用不可後の操作はドライバへ一切渡らない（`BEGIN` すら打たれない）。
    expect(execLog).toEqual([]);

    // 放置されたトランザクションに、その後の `run`（"after"）の書き込みは
    // 混ざっていない（生の接続で確認する — ポート経由の `all` はすでに使用
    // 不可で使えない）。"should-not-remain" は `fn` 自身が放置された
    // トランザクションの中で書いた行で、同じ生の接続からはコミット前でも
    // 見える（未コミットの自分の書き込み）ため、それ自体は消えない——
    // ここで確かめたいのは「その後の操作」の書き込みが入り込んでいないこと。
    expect(raw.prepare("SELECT name FROM items ORDER BY id").all()).toEqual([{ name: "should-not-remain" }]);

    raw.close();
  });

  it("(b) 失敗する transaction と同時に（await せず）呼んだ db.run も、排他区間の内側で判定され拒否される", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql === "ROLLBACK"),
    );
    const originalError = new Error("fn failure (top-level ROLLBACK will be rejected before executing)");

    const txPromise = db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["should-not-remain"]);
      throw originalError;
    });
    // `transaction` の呼び出しと同時に、`await` せず別の操作を発行する。
    // ミューテックスのキューにより、この操作は `transaction` の排他区間が
    // 終わってから実行されるので、失敗の判定（`unusable` の記録）はこの
    // 操作の実行前に済んでいるはず。
    const concurrentRunPromise = db.run("INSERT INTO items (name) VALUES (?)", ["concurrent-should-not-remain"]);

    await expect(txPromise).rejects.toBe(originalError);
    await expect(concurrentRunPromise).rejects.toThrow(/unusable/);

    // 同時に発行した `run`（"concurrent-should-not-remain"）は排他区間の
    // 内側で拒否され、ドライバへ渡っていない。"should-not-remain" は `fn`
    // 自身が放置されたトランザクションの中で書いた行なので、同じ生の接続
    // からは（未コミットのまま）残って見える。
    expect(raw.prepare("SELECT name FROM items ORDER BY id").all()).toEqual([{ name: "should-not-remain" }]);
    raw.close();
  });

  it("(c) エラーの cause は ROLLBACK の拒否エラーである", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql === "ROLLBACK"),
    );

    await expect(
      db.transaction(async () => {
        throw new Error("fn failure");
      }),
    ).rejects.toThrow("fn failure");

    let caught: unknown;
    try {
      await db.run("INSERT INTO items (name) VALUES (?)", ["after"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(((caught as Error).cause as Error).message).toMatch(/simulated rejection before executing: ROLLBACK$/);
    raw.close();
  });

  it("(d) 入れ子の ROLLBACK TO が失敗して外側がコミット不可になり、続くトップレベルの ROLLBACK まで拒否された場合も、ポートは使用不可になる", async () => {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    // `ROLLBACK TO ...` と `ROLLBACK` の両方を実行前に拒否する。
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql.startsWith("ROLLBACK")),
    );

    await expect(
      db.transaction(async (tx) => {
        await tx
          .transaction(async () => {
            throw new Error("inner failure");
          })
          .catch(() => undefined);
        return "outer-returned-normally";
      }),
    ).rejects.toThrow(/ROLLBACK TO/);
    expect(raw.inTransaction).toBe(true);

    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after"])).rejects.toThrow(/unusable/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    raw.close();
  });
});

describe("createSerializedDb — #623: トップレベルの BEGIN IMMEDIATE が失敗を返しても、放置されたトランザクションへ書き込みを漏らさない", () => {
  function createItemsRaw(): Database.Database {
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`);
    return raw;
  }

  it("(a) BEGIN IMMEDIATE を実行したうえで失敗を返すと、BEGIN の元の例外が同じオブジェクトのまま伝わり、開いたトランザクションは ROLLBACK で閉じられ、以後の操作はオートコミットで正常に進む", async () => {
    const raw = createItemsRaw();
    const inner = createBetterSqlite3Driver(raw);
    const beginError = new Error("BEGIN IMMEDIATE executed, but the driver reported a failure");
    let beginFailed = false;
    const db = createSerializedDb({
      ...inner,
      async exec(sql: string) {
        await inner.exec(sql);
        if (sql === "BEGIN IMMEDIATE" && !beginFailed) {
          beginFailed = true;
          throw beginError;
        }
      },
    });

    let fnCalled = false;
    await expect(
      db.transaction(async () => {
        fnCalled = true;
      }),
    ).rejects.toBe(beginError);
    expect(fnCalled).toBe(false);

    // 開いたまま放置されず、閉じられている。
    expect(raw.inTransaction).toBe(false);

    // 以後の操作は放置トランザクションへ合流せず、オートコミットで確定する。
    await db.run("INSERT INTO items (name) VALUES (?)", ["after-begin-failure"]);
    expect(raw.inTransaction).toBe(false);
    expect(await db.transaction(async (tx) => tx.all("SELECT name FROM items"))).toEqual([
      { name: "after-begin-failure" },
    ]);
    raw.close();
  });

  it("(b) BEGIN IMMEDIATE を実行したうえで失敗を返し、後始末の ROLLBACK も実行前に拒否されると、以後このポートは使用不可になり、放置されたトランザクションへ書き込みは混ざらない", async () => {
    const raw = createItemsRaw();
    const { driver, execLog } = driverWithExecLog(
      driverThatRejectsBeforeExec(
        driverThatFailsOnceAfterRealExec(createBetterSqlite3Driver(raw), (sql) => sql === "BEGIN IMMEDIATE"),
        (sql) => sql === "ROLLBACK",
      ),
    );
    const db = createSerializedDb(driver);

    const txPromise = db.transaction(async () => "should-not-run");
    // `transaction` と同時に（await せず）発行した操作も、排他区間の内側で拒否される。
    const concurrentRunPromise = db.run("INSERT INTO items (name) VALUES (?)", ["concurrent"]);

    await expect(txPromise).rejects.toThrow(/simulated failure after actually executing: BEGIN IMMEDIATE$/);
    await expect(concurrentRunPromise).rejects.toThrow(/unusable/);

    // SQLite 側のトランザクションは開いたまま（後始末できていない）。
    expect(raw.inTransaction).toBe(true);

    execLog.length = 0;
    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after"])).rejects.toThrow(/unusable/);
    await expect(db.get("SELECT * FROM items")).rejects.toThrow(/unusable/);
    await expect(db.all("SELECT * FROM items")).rejects.toThrow(/unusable/);
    await expect(db.exec("SELECT 1")).rejects.toThrow(/unusable/);
    await expect(db.transaction(async () => "should-not-run")).rejects.toThrow(/unusable/);
    // 使用不可後の操作はドライバへ一切渡らない。
    expect(execLog).toEqual([]);

    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    raw.close();
  });

  it("(c) 使用不可のエラーは BEGIN の失敗が原因であることを示し、cause は状態を確かめられなかった直接の理由（確認の BEGIN の失敗）である", async () => {
    const raw = createItemsRaw();
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(
        driverThatFailsOnceAfterRealExec(createBetterSqlite3Driver(raw), (sql) => sql === "BEGIN IMMEDIATE"),
        (sql) => sql === "ROLLBACK" || sql === "BEGIN",
      ),
    );

    await expect(db.transaction(async () => undefined)).rejects.toThrow(/BEGIN IMMEDIATE/);

    let caught: unknown;
    try {
      await db.run("INSERT INTO items (name) VALUES (?)", ["after"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/BEGIN IMMEDIATE/);
    expect((caught as Error).message).toMatch(/unusable/);
    expect(((caught as Error).cause as Error).message).toMatch(/simulated rejection before executing: BEGIN$/);
    raw.close();
  });

  it("(d) BEGIN IMMEDIATE が実行前に拒否された通常の失敗（例: SQLITE_BUSY）では、BEGIN の元の例外が同じオブジェクトのまま伝わり、ポートは使用不可にならない", async () => {
    const raw = createItemsRaw();
    const inner = createBetterSqlite3Driver(raw);
    const busyError = new Error("simulated SQLITE_BUSY: BEGIN IMMEDIATE rejected before executing");
    let rejected = false;
    const db = createSerializedDb({
      ...inner,
      async exec(sql: string) {
        if (sql === "BEGIN IMMEDIATE" && !rejected) {
          rejected = true;
          throw busyError;
        }
        await inner.exec(sql);
      },
    });

    await expect(db.transaction(async () => "should-not-run")).rejects.toBe(busyError);
    expect(raw.inTransaction).toBe(false);

    // ポートは使用可能なまま。次のトランザクションは正常にコミットされる。
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["after-busy"]);
    });
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare("SELECT name FROM items").all()).toEqual([{ name: "after-busy" }]);
    raw.close();
  });

  it("(e) BEGIN が実行前に拒否され続け、トランザクション状態を確かめられない（ドライバが BEGIN を受け付けない）場合は、使用不可に倒す", async () => {
    const raw = createItemsRaw();
    const db = createSerializedDb(
      driverThatRejectsBeforeExec(createBetterSqlite3Driver(raw), (sql) => sql.startsWith("BEGIN")),
    );

    await expect(db.transaction(async () => undefined)).rejects.toThrow(
      /simulated rejection before executing: BEGIN IMMEDIATE$/,
    );
    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after"])).rejects.toThrow(/unusable/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    raw.close();
  });

  it("(f) BEGIN IMMEDIATE が実行前に拒否され、確認の BEGIN は通ったのに確認後の ROLLBACK が実行前に拒否されると、確認で開いたトランザクションが残るので使用不可に倒す", async () => {
    const raw = createItemsRaw();
    const inner = createBetterSqlite3Driver(raw);
    let rollbackCount = 0;
    const db = createSerializedDb({
      ...inner,
      async exec(sql: string) {
        if (sql === "BEGIN IMMEDIATE") {
          throw new Error("simulated rejection before executing: BEGIN IMMEDIATE");
        }
        // 1 回目（後始末の ROLLBACK）は実際に実行させ「トランザクションが無い」で失敗させ、
        // 2 回目（確認後の ROLLBACK）は実行前に拒否する。
        if (sql === "ROLLBACK" && ++rollbackCount === 2) {
          throw new Error("simulated rejection before executing: probe ROLLBACK");
        }
        await inner.exec(sql);
      },
    });

    await expect(db.transaction(async () => undefined)).rejects.toThrow(/BEGIN IMMEDIATE$/);
    // 確認の BEGIN で開いたトランザクションが閉じられずに残っている。
    expect(raw.inTransaction).toBe(true);

    await expect(db.run("INSERT INTO items (name) VALUES (?)", ["after"])).rejects.toThrow(/unusable/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    raw.close();
  });
});
