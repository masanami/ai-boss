import type { Db, DbPort, RunResult } from "../../../server/src/db/db-port.js";

/**
 * 製品版の DB を準備できなかったときに `createCoreApp` に渡す DB ポート
 * （#579 S2 で「DB 未接続の間」の DB として入り、#580 S2 で製品版の DB
 * 〔plugin-sql〕の準備に失敗したときのフォールバックになった。
 * `boot-product-app.ts`・機能仕様 docs/features/async-db-layer.md 仮定 A7）。
 *
 * このポートはすべての操作を「DB 未接続」のエラーで拒否し、SQL を一切
 * 実行しない。`transaction` は渡された関数 `fn` を**呼ばずに**拒否する
 * （`fn` の中の DB 操作もすべて拒否される必要が無い設計であることの確認 —
 * `fn` 自体が呼ばれないので、その中の判定・書き込みは実行されない）。
 */
export class DbNotConnectedError extends Error {
  constructor() {
    super("DB未接続です（製品版のDBを準備できませんでした）");
    this.name = "DbNotConnectedError";
  }
}

function rejectNotConnected<T>(): Promise<T> {
  return Promise.reject(new DbNotConnectedError());
}

/** `Db`（`DbPort`/`DbTx` の別名）を満たす、常に拒否するだけの実装。 */
const disconnectedDb: Db = {
  run(): Promise<RunResult> {
    return rejectNotConnected();
  },
  get<T = unknown>(): Promise<T | undefined> {
    return rejectNotConnected();
  },
  all<T = unknown>(): Promise<T[]> {
    return rejectNotConnected();
  },
  exec(): Promise<void> {
    return rejectNotConnected();
  },
  // `fn` を受け取らない（= 呼ばない）ことで「DB未接続」を表す。TypeScript は
  // メソッドの実引数がインターフェースの仮引数より少ないことを許すため、
  // ここで `fn: (tx: DbTx) => Promise<T> | T` を書かなくても `Db` を満たす。
  transaction<T>(): Promise<T> {
    return rejectNotConnected();
  },
};

/** 呼ぶたびに、DB に一切触れない同じ形の DB ポートを返す（状態を持たないので
 * 複数回呼んでも安全。テストのため関数として公開する）。 */
export function createDisconnectedDbPort(): DbPort {
  return disconnectedDb;
}
