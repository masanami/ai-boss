import type { DbDriver, RunResult, SqlValue } from "../db-port.js";

/**
 * テスト専用の補助（`test-support/`。機能仕様
 * docs/features/async-db-layer.md「移行期の共通規約」・#601 完了条件）。
 *
 * 内側のドライバ `inner` を包み、`matches(sql)` が真を返す SQL 文の実行
 * **直後**に `after()` フックを差し込める {@link DbDriver}。AC-19/AC-20
 * （判定の読み出しの直後に、別の流れの変更を決定的に割り込ませる）のような
 * テストで、壁時計（`setTimeout` 等）に頼らずに割り込みのタイミングを固定
 * するために使う。
 *
 * **フックの中で、割り込ませたい別の DB 操作を `await` しないこと。**
 * このフックが呼ばれている間、直列化層（`serialized-db.ts`）のロックは
 * まだ解放されていない（このフック自身が、そのロックを握っている操作の
 * 内側から呼ばれているため）。フックの中で同じ直列化済みポートの操作を
 * 起動する場合は、起動するだけで `await` せずに返すこと。起動した操作は
 * 直列化層のキューに積まれ、ロックが解放され次第（＝現在の操作が終わり
 * 次第）実行される。
 */
export interface DriverHook {
  /** この SQL 文の実行直後にフックを差し込むかどうか。 */
  matches: (sql: string) => boolean;
  /** SQL 文の実行直後に呼ばれる。 */
  after: () => void | Promise<void>;
}

/**
 * `createHookedDriver(inner, hooks)` の使い方（self-review・code-reviewer/
 * design-reviewer 指摘: 下記の要点はこれまでテストのコメントにしか書かれて
 * いなかったため、後続チケット〔AC-8/AC-19/AC-20/AC-21 等〕がこの補助を
 * 再利用する前提でここへ集約する）:
 *
 * 1. `matches(sql)` には `run`/`get`/`all`/`exec` すべての SQL 文が渡る。
 *    `exec` 経由の `BEGIN IMMEDIATE`／`SAVEPOINT ...`／`COMMIT`／
 *    `ROLLBACK` などの制御文も対象になるため、割り込ませたい「判定の
 *    読み出し」だけに絞った述語（例: `sql.startsWith("SELECT") && ...`）を
 *    書くこと。
 * 2. 1回だけ発火させたい場合は、`matches` の中で「すでに発火したか」を
 *    見るフラグを自分で持つこと（例: `let hookFired = false;` を
 *    `matches: (sql) => sql.startsWith("SELECT") && !hookFired` のように
 *    参照し、`after` の中で `hookFired = true` にする）。とくに、割り込み
 *    を確かめた後にテストが検証用の `SELECT` を発行する場合、同じ
 *    `matches` がその検証用クエリにも反応して二重に発火してしまう
 *    （最初の1回だけに絞らないと、2回目の割り込みが待ち合わされないまま
 *    残る）。
 * 3. **`after()` の中で、割り込ませたい別の流れの DB 操作を `await` しない
 *    こと。** `after()` はこのフックが差し込まれた操作（＝直列化層の
 *    ロックを握っている操作）の内側から呼ばれているため、`await` すると
 *    そのロックの解放待ちで固まる。起動する（`db.run(...)` 等を呼ぶ）だけ
 *    で、その戻り値の Promise は `await` せずに変数へ控えておき、テスト
 *    側があとで（元のトランザクションの決着を確認した後に）その Promise
 *    を `await` して結果を検証する。
 * 4. 割り込みが実際に効いていることを確かめるには、直列化層のロックを
 *    外した（＝修正前の）コードでこのテストを実行し、期待する順序の
 *    アサーションが落ちることを確認する（このテストが「有効」であること
 *    自体の裏取り）。
 */
export function createHookedDriver(inner: DbDriver, hooks: DriverHook[]): DbDriver {
  async function afterExec(sql: string): Promise<void> {
    for (const hook of hooks) {
      if (hook.matches(sql)) {
        await hook.after();
      }
    }
  }

  return {
    async run(sql: string, params?: SqlValue[]): Promise<RunResult> {
      const result = await inner.run(sql, params);
      await afterExec(sql);
      return result;
    },
    async get<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
      const result = await inner.get<T>(sql, params);
      await afterExec(sql);
      return result;
    },
    async all<T = unknown>(sql: string, params?: SqlValue[]): Promise<T[]> {
      const result = await inner.all<T>(sql, params);
      await afterExec(sql);
      return result;
    },
    async exec(sql: string): Promise<void> {
      await inner.exec(sql);
      await afterExec(sql);
    },
  };
}
