import type { Db, DbDriver, DbPort, DbTx, SqlValue } from "./db-port.js";

/**
 * Promise を鎖にして「1つずつ順番に」実行する最小の非同期ミューテックス。
 * 直前のタスクが成功・失敗どちらで終わっても、次のタスクは必ず実行される
 * （失敗後もロックが解放され次の操作が進むという契約 — 機能仕様「IF / API」
 * 節・#601 完了条件）。
 */
function createMutex() {
  let tail: Promise<unknown> = Promise.resolve();

  function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => task();
    // 直前のタスクの成功/失敗いずれの場合も `run` を呼ぶことで、失敗した
    // タスクの後続を止めない。
    const result = tail.then(run, run);
    // `tail` 自体は成功/失敗の値を持ち越さない（次のタスクへの合図としてだけ
    // 使う）。ここで catch しておかないと、失敗した `result` が
    // unhandledRejection として検出されてしまう。
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { runExclusive };
}

interface TxState {
  finished: boolean;
  /**
   * 親（外側）の `tx`（または最上位なら `undefined`）の状態。`fn` が
   * 入れ子の `tx.transaction(...)` の戻り値を `await` せずに返す（＝
   * 内側のトランザクションを漏らす）と、内側の `tx` は自分自身の
   * `finished` を見ているだけでは、外側がすでに `COMMIT`／`ROLLBACK` して
   * ロックを解放した後もアクティブに見えてしまう（self-review・
   * code-reviewer/design-reviewer 双方が独立に指摘・CONFIRMED: 漏れた
   * 内側の `tx` へ書き込むと、直列化層のロックの外・オートコミットで
   * 実行されてしまう）。`assertActive` が祖先までさかのぼって確認する
   * ことで、漏れた `tx` の使用を確実に例外にする。
   */
  parent?: TxState;
  /**
   * この `tx` が現在、自分自身の入れ子 `transaction(fn)` を実行中か
   * （`SAVEPOINT` を張ってから `RELEASE`／`ROLLBACK TO` するまでの間）。
   *
   * **経緯（self-review 2周目・code-reviewer/design-reviewer 双方が独立に
   * 指摘・CONFIRMED）**: 1周目では「同じ `tx` への呼び出しをキューで
   * 直列化する」ローカルミューテックスを試したが、これは**入れ子の `fn`
   * が祖先の `tx` を呼び返す**（`fn` の中で外側の `tx` を使う。仕様が明示
   * する「T2/T3 でとくに間違えやすい」パターン）と、その呼び出し自身が
   * 同じキューの自分の後ろに並んでしまい、**祖先の `tx` の操作も接続全体の
   * ロックも二度と解放されないデッドロック**になった（実測で確認）。
   * `busy` は待たせず、**即座に例外にする**（非再入のガード）ことで、
   * 同じ問題を「固まる」ではなく「即座に失敗する」に変える。これにより
   * 兄弟の入れ子トランザクションの並行実行（本来の1周目の指摘）も、
   * 祖先の `tx` への呼び返しも、どちらも同じ理由で即座に例外になる —
   * 前者は「呼び出し順を保証してほしいなら `await` してから次を呼ぶ」、
   * 後者は「`fn` の中では渡された `tx` だけを使う」という、どちらも既存の
   * 契約（機能仕様・決定1）の範囲内の誤用として扱える。
   *
   * **既知の制約（self-review 3周目・code-reviewer 指摘・CONFIRMED。S1 の
   * 同期ドライバでは再現しない）**: `fn` が `Promise.all`（`allSettled`
   * ではなく）で兄弟の入れ子トランザクションを2つ張ると、後発の呼び出しは
   * この `busy` チェックで即座に拒否される。`Promise.all` は最初に決着した
   * 拒否ですぐ reject するため、非同期ドライバ（S2 の plugin-sql）の下では、
   * 先発の兄弟の `SAVEPOINT`〜`RELEASE`／`ROLLBACK TO` がまだ実行中でも、
   * `fn` はその完了を待たずに例外を投げて戻りうる。この状態で親がそのまま
   * `COMMIT`／`ROLLBACK` へ進むと、まだ実行中の兄弟の文が親の後始末と同じ
   * 接続の上で入り混じる恐れがある。**この状態を親側で待ち合わせる修正を
   * 一度試したが、`fn` が返す Promise が（バグにより）永久に解決しない
   * 場合に、親の `COMMIT`／`ROLLBACK` そのものが永久に進まなくなる
   * （接続全体の恒久的なハング）という、既存の「漏れた `tx` は使用時に
   * 例外になる」契約より悪い退行を生んだため、この場では採用しなかった**
   * （待ち合わせに上限時間を設ける等の対応は、非同期ドライバが実在する S2
   * で、実際のタイミング特性を見てから設計する）。S1 の対象ドライバ
   * （better-sqlite3、常に同期）では `await` を挟まず完結するため、この
   * 窓は開かない。
   */
  busy: boolean;
  /**
   * 最上位の `tx` の状態にだけ置く。入れ子の `ROLLBACK TO` が失敗したとき、
   * その失敗の例外を記録する（PR #615 Codex 指摘・P2）。ドライバが
   * `ROLLBACK TO` を**実行前に**拒否した場合、内側の書き込みは戻っていない
   * のに `RELEASE` で外側へ合流してしまう。後始末が実際に効いたかは
   * 呼び出し元から判別できないため、失敗したら一律にトランザクション全体を
   * 「コミット不可」にする: 以後この木のどの `tx` の操作も即座に例外にし
   * （SQLite が自分でトランザクションを畳んでいた場合に、後続の書き込みが
   * オートコミットへ漏れないようにする）、最上位は `fn` が正常に返っても
   * `COMMIT` せず `ROLLBACK` して例外で終わる。`fn` が投げた元の例外は
   * 従来どおり同じオブジェクトのまま内側の呼び出し元へ伝わる（AC-2b）。
   */
  rollbackFailure?: { error: unknown };
}

function rootOf(state: TxState): TxState {
  let current = state;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function nestedRollbackFailedError(cause: unknown): Error {
  return new Error(
    "a nested `transaction(fn)` failed and its `ROLLBACK TO` also failed, so the inner " +
      "writes may not have been rolled back; the whole transaction has been rolled back " +
      "instead of committed",
    { cause },
  );
}

/**
 * #617: トップレベルの `transaction(fn)` の後始末の `ROLLBACK` 自体が失敗
 * したときのエラー。`nestedRollbackFailedError` と同じ考え方——後始末が
 * 実際に効いたかを `DbDriver` の契約から判別する手段が無いため、再接続・
 * 自動回復は行わず一律にポート全体を使用不可にする（YAGNI）。
 */
function portUnusableAfterTopLevelRollbackFailureError(cause: unknown): Error {
  return new Error(
    "a top-level `transaction(fn)`'s `ROLLBACK` failed, so the transaction state is unknown " +
      "and this DB port is now unusable; there is no way to tell whether the driver's " +
      "autocommit state was actually restored, so every further operation on this port is " +
      "rejected instead of silently joining the abandoned transaction — restart the process " +
      "and open a new DB port",
    { cause },
  );
}

function assertActive(state: TxState): void {
  const { rollbackFailure } = rootOf(state);
  if (rollbackFailure) {
    throw nestedRollbackFailedError(rollbackFailure.error);
  }
  let current: TxState | undefined = state;
  while (current) {
    if (current.finished) {
      throw new Error(
        "this `tx` has already finished (its `transaction()` call, or an ancestor " +
          "transaction's `transaction()` call, already resolved); do not use a `tx` " +
          "after the `transaction(fn)` call that produced it (or an outer `tx` it was " +
          "nested under) has returned — and always `await` nested `tx.transaction(...)` " +
          "calls before returning from `fn` (an un-awaited nested transaction is a leak)",
      );
    }
    current = current.parent;
  }
}

function assertNotBusy(state: TxState): void {
  if (state.busy) {
    throw new Error(
      "this `tx` is currently running its own nested `transaction(fn)` call " +
        "(a `SAVEPOINT` is open and has not been `RELEASE`d/`ROLLBACK TO`'d yet); " +
        "do not call another operation on this same `tx` until that nested " +
        "`transaction(fn)` call has resolved — this includes calling the `tx` again " +
        "from inside its own nested `fn` (always use the `tx` argument passed to " +
        "*that* `fn`, not an outer one) and starting two `tx.transaction(...)` calls " +
        "concurrently (e.g. via `Promise.all`) without awaiting the first one",
    );
  }
}

/**
 * SAVEPOINT の名前を一意にするための、プロセス内で単調増加するカウンタ。
 * 深さ（ネストの段数）だけを名前に使うと、同じ親 `tx` から兄弟の入れ子
 * トランザクションを（誤って）並行に張ったとき名前が衝突し、片方の
 * `ROLLBACK TO`／`RELEASE` がもう片方の SAVEPOINT を巻き込む
 * （self-review・code-reviewer/design-reviewer 双方が独立に指摘・
 * CONFIRMED）。呼び出しごとに一意な名前を振ることで、この衝突を無くす。
 */
let nextSavepointId = 0;
function nextSavepointName(): string {
  nextSavepointId += 1;
  return `sp_${nextSavepointId}`;
}

/**
 * `fn` に渡す `tx` ハンドル。直列化層の「トップレベルの」ロックは（外側の
 * `transaction` かこの関数の呼び出し元がすでに保持しているため）ここでは
 * 取らない — ドライバへそのまま委譲するだけ。
 *
 * 同じ `tx` が自分自身の入れ子 `transaction(fn)` を実行中（`busy`）の間は、
 * この `tx` への他の呼び出し（`run`/`get`/`all`/`exec`/`transaction` の
 * どれでも）を**待たせず、即座に例外にする**（`assertNotBusy` 参照。上記
 * `TxState.busy` のコメントに経緯を記す）。
 */
function createTxHandle(driver: DbDriver, state: TxState): DbTx {
  async function op<T>(task: () => T | Promise<T>): Promise<T> {
    // ここでの同期 throw を、呼び出し元の `run`/`get`/... が同期関数のまま
    // でも確実に「拒否された Promise」へ変換するため、`op` 自体を `async`
    // にしている（呼び出し元は常に Promise を受け取る契約 — {@link Db}）。
    assertActive(state);
    assertNotBusy(state);
    return task();
  }

  return {
    run(sql: string, params?: SqlValue[]) {
      return op(() => driver.run(sql, params));
    },
    get<T>(sql: string, params?: SqlValue[]) {
      return op(() => driver.get<T>(sql, params));
    },
    all<T>(sql: string, params?: SqlValue[]) {
      return op(() => driver.all<T>(sql, params));
    },
    exec(sql: string) {
      return op(() => driver.exec(sql));
    },
    transaction<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T> {
      return op(async () => {
        state.busy = true;
        try {
          return await runNestedTransaction(driver, state, fn);
        } finally {
          state.busy = false;
        }
      });
    },
  };
}

/**
 * 入れ子のトランザクション。ロックは再取得せず（すでに外側が保持している）、
 * `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` で合成する。
 *
 * **呼び出し元は、この呼び出しが返す Promise を必ず `await` すること。**
 * `await` せずに `fn` から返すと、内側の `tx` が漏れる（上記 `TxState.parent`
 * のコメント参照）。
 */
async function runNestedTransaction<T>(
  driver: DbDriver,
  parentState: TxState,
  fn: (tx: DbTx) => Promise<T> | T,
): Promise<T> {
  const savepoint = nextSavepointName();
  const state: TxState = { finished: false, parent: parentState, busy: false };
  const tx = createTxHandle(driver, state);

  await driver.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = await fn(tx);
    await driver.exec(`RELEASE ${savepoint}`);
    state.finished = true;
    return result;
  } catch (err) {
    // 後始末（`ROLLBACK TO`・`RELEASE`）自体が失敗しても、`fn` が投げた
    // 元の例外 `err` を優先して「同じオブジェクトのまま」投げ直す
    // （AC-2b。self-review・code-reviewer/design-reviewer 双方が独立に
    // 指摘・CONFIRMED: 後始末の例外を素通しすると、ここで `err` が
    // ロールバック側の例外にすり替わってしまっていた）。2つの文は
    // 独立に試す — `ROLLBACK TO` が失敗しても `RELEASE` は試みる
    // （SAVEPOINT をスタックに残さないため）。
    try {
      await driver.exec(`ROLLBACK TO ${savepoint}`);
    } catch (rollbackError) {
      // `err` は優先して投げ直すが、内側の書き込みが戻ったとは言えないので、
      // トランザクション全体をコミット不可にする（`TxState.rollbackFailure`
      // 参照）。下の `RELEASE` は独立に試し、最終的に `err` を throw する。
      rootOf(parentState).rollbackFailure ??= { error: rollbackError };
    }
    try {
      await driver.exec(`RELEASE ${savepoint}`);
    } catch {
      // 握りつぶす。ここでの後始末の失敗は、下の `finally`
      // （`state.finished = true`）や `err` の投げ直しを妨げない。この
      // 呼び出し（子の `tx.transaction(fn)`）を包んでいる
      // `createTxHandle` の `transaction` メソッド側の `finally` が、
      // 親 `state.busy` を `false` に戻す（self-review 3周目・
      // code-reviewer 指摘: 「ロックの解放」という言い方は、実際には
      // 単一のロック機構ではなく、`busy` フラグの解除とトップレベルの
      // `mutex`〔`createSerializedDb` 側〕という別々の仕組みなので、
      // それぞれが担う場所を正確に書く）。
    } finally {
      state.finished = true;
    }
    throw err;
  }
}

/**
 * トップレベルのトランザクション。呼び出し時点で直列化層のロックはすでに
 * `createSerializedDb` 側の `runExclusive` が保持している。
 *
 * `onRollbackFailure` は、この `transaction(fn)` の後始末の `ROLLBACK` 自体が
 * 失敗したときに呼ばれる（#617）。ドライバが `ROLLBACK` を**実行前に**拒否
 * すると、SQLite 側のトランザクションは開いたまま残るのに、この呼び出しの
 * ロック（`createSerializedDb` の `mutex`）はここでは解放してしまう——その
 * 状態で呼び出し元が次の `db.run` 等を呼ぶと、放置されたトランザクションへ
 * 黙って合流してしまう（Issue #617）。後始末が実際に効いたかは
 * `DbDriver` の契約からは判別できないため、`runTopLevelTransaction` 自身は
 * 何もせず（ロックは解放して固まらせない）、記録は呼び出し元
 * （`createSerializedDb`）に委ねる——呼び出し元がポート全体を使用不可にする
 * ことで、放置されたトランザクションへの合流を防ぐ（入れ子の `ROLLBACK TO`
 * 失敗と同じ理屈。`TxState.rollbackFailure` 参照）。
 */
async function runTopLevelTransaction<T>(
  driver: DbDriver,
  fn: (tx: DbTx) => Promise<T> | T,
  onRollbackFailure: (error: unknown) => void,
): Promise<T> {
  const state: TxState = { finished: false, busy: false };
  const tx = createTxHandle(driver, state);

  // A2（機能仕様・仮定）: `BEGIN IMMEDIATE` を使う。接続1本では DEFERRED と
  // 差は無いが、将来の複数接続で書き込みロックの取り損ねを避ける。
  await driver.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn(tx);
    if (state.rollbackFailure) {
      // 入れ子の後始末が失敗している（`TxState.rollbackFailure` 参照）。
      // コミットせず、下の catch で `ROLLBACK` してこの例外で終わる。
      throw nestedRollbackFailedError(state.rollbackFailure.error);
    }
    await driver.exec("COMMIT");
    state.finished = true;
    return result;
  } catch (err) {
    // 入れ子版と同じ理由（上記コメント参照）で、`ROLLBACK` 自体の失敗を
    // 握りつぶし、`fn` が投げた元の例外 `err` を必ず投げ直す（AC-2b）。
    // ただし #617: 握りつぶす前に `onRollbackFailure` へ通知し、呼び出し元
    // がポート全体を使用不可にできるようにする（後始末が効いたかどうかを
    // 判別できない以上、以後の操作を放置トランザクションへ合流させない）。
    try {
      await driver.exec("ROLLBACK");
    } catch (rollbackError) {
      onRollbackFailure(rollbackError);
    } finally {
      state.finished = true;
    }
    throw err;
  }
}

/**
 * `driver`（1本の接続の上で文を実行するだけの {@link DbDriver}）を包み、
 * 非同期のロックで DB 操作を1つずつ通す {@link DbPort} を組み立てる
 * （機能仕様 docs/features/async-db-layer.md クリティカル設計決定1）。
 *
 * ドライバに依存しない（コア側）。開発者用の版は better-sqlite3 実装
 * （`connection.ts`）を、製品版は plugin-sql 実装（S2）を渡す。
 */
export function createSerializedDb(driver: DbDriver): DbPort {
  const mutex = createMutex();
  /**
   * トップレベルの `ROLLBACK` が失敗したときの記録（#617）。入れ子の
   * `ROLLBACK TO` 失敗（`TxState.rollbackFailure`）と同じ考え方だが、対象は
   * この `createSerializedDb` が返すポート**全体**——記録後はどの操作
   * （`run`/`get`/`all`/`exec`/`transaction`）も、ドライバへ一切触れずに
   * （`BEGIN` も打たずに）即座に拒否する。判定は `mutex.runExclusive` の
   * コールバックの中（排他区間の内側）で行うため、失敗した `transaction`
   * の直後にすでにキューされていた操作（`transaction` の呼び出しと同時に
   * `await` せず呼んだ別の操作を含む）も漏れなく拒否される。再接続・
   * 自動回復は行わない（YAGNI — `DbDriver` に autocommit 状態を問い合わせる
   * 手段が無く、後始末が効いたか判別できないため、入れ子版と同じ理屈で
   * 一律に使用不可へ倒す）。
   */
  let unusable: { error: unknown } | undefined;

  function assertUsable(): void {
    if (unusable) {
      throw portUnusableAfterTopLevelRollbackFailureError(unusable.error);
    }
  }

  /** 排他区間の内側で使用可否を確かめてから `task` を実行する（全操作の共通の入口）。 */
  function runUsable<T>(task: () => T | Promise<T>): Promise<T> {
    return mutex.runExclusive(async () => {
      assertUsable();
      return task();
    });
  }

  const port: Db = {
    run(sql: string, params?: SqlValue[]) {
      return runUsable(() => driver.run(sql, params));
    },
    get<T>(sql: string, params?: SqlValue[]) {
      return runUsable(() => driver.get<T>(sql, params));
    },
    all<T>(sql: string, params?: SqlValue[]) {
      return runUsable(() => driver.all<T>(sql, params));
    },
    exec(sql: string) {
      return runUsable(() => driver.exec(sql));
    },
    transaction<T>(fn: (tx: DbTx) => Promise<T> | T) {
      // トランザクション全体（BEGIN〜COMMIT/ROLLBACK と、その間に `fn` が
      // 行うすべての DB 操作）を1つの排他区間として取る。`fn` の中で
      // `tx`（この排他区間の中で直接ドライバを叩く）以外にこのポート自身の
      // メソッドを呼ぶと、この排他区間が終わるまで解決しない
      // `mutex.runExclusive` にキューイングされ、待ち続ける
      // （= デッドロック。db-port.ts の `Db.transaction` の JSDoc 参照）。
      return runUsable(() =>
        runTopLevelTransaction(driver, fn, (rollbackError) => {
          unusable ??= { error: rollbackError };
        }),
      );
    },
  };

  return port;
}
