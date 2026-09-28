import type { Db, DbPort, RunResult } from "../../../server/src/db/db-port.js";

/**
 * S2 の製品版のエントリが `createCoreApp` に渡す DB ポート（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定4・S2「DB 未接続の
 * 間の振る舞い」）。
 *
 * #580 の S2（plugin-sql の実装）が済むまで、Tauri アプリは DB に接続しない
 * — このポートはすべての操作を「DB 未接続」のエラーで拒否し、SQL を一切
 * 実行しない。`transaction` は渡された関数 `fn` を**呼ばずに**拒否する
 * （`fn` の中の DB 操作もすべて拒否される必要が無い設計であることの確認 —
 * `fn` 自体が呼ばれないので、その中の判定・書き込みは実行されない）。
 */
export class DbNotConnectedError extends Error {
  constructor() {
    super("DB未接続です（製品版のTauriアプリはS2の時点でDBに接続しません）");
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
