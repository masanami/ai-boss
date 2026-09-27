/**
 * 非同期の DB ポートの型定義（#601・機能仕様 docs/features/async-db-layer.md
 * 「IF / API」節）。
 *
 * このファイルは import を一切持たない（コア側・Node 組み込みにも
 * better-sqlite3 にも依存しない純粋な型定義）。開発者用の版
 * （better-sqlite3）と製品版（plugin-sql、S2 で追加）の両方が同じ形の
 * ポートを実装できるようにするための共通契約。
 */

/** SQL の位置パラメータ（`?`）に束縛できる値。現行コードは名前付き
 * パラメータも BLOB 値も bigint 値も使わないため、この3つは対象外（YAGNI。
 * self-review・design-reviewer 指摘: `bigint` は S2 の plugin-sql 実装が
 * Tauri の `invoke`〔JSON シリアライズ〕を経由するため運べない値であり、
 * 使われていない型を共通契約に含めない）。 */
export type SqlValue = string | number | null;

/** 書き込み文（`run`）の結果。better-sqlite3 の `.changes`/`.lastInsertRowid`
 * を踏襲した名前だが、`lastInsertRowid` は bigint ではなく number にする
 * （機能仕様「IF / API」節）。 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * `DbPort`（トップレベルの接続）と `DbTx`（トランザクションの中）が共通に
 * 持つ操作。`DbPort`/`DbTx` はどちらもこの `Db` の別名であり、構造的な区別は
 * 設けていない（#601 の軽微・可逆な仮定。tx をトップレベルと型で区別する
 * ことは将来必要になった時点で導入できる）。**型で区別しても「`fn` の中では
 * 渡された `tx` だけを使う」という誤りは防げない**——外側のポート・祖先の
 * `tx` もどちらも構造的には同じ `Db` 型であり、呼び出し元が正しい引数
 * （渡された `tx`）を選んで使うかどうかはコードレビューで確認する
 * （self-review・design-reviewer 指摘。機能仕様・決定1が明記するとおり）。
 * 誤ると、外側のポートを呼んだ場合はロックの二重取得で待ち続け（テストは
 * タイムアウトで気付く）、祖先の `tx` を呼んだ場合は**即座に例外になる**
 * （上記 `transaction` の JSDoc 参照。self-review 2周目で見つかった経緯:
 * 当初は「固まらず内側の SAVEPOINT に巻き込まれる」実装だったが、その後の
 * 修正〔祖先の `tx` が現在の入れ子トランザクション中は「busy」を即座に
 * 例外にする〕でこの記述は誤りになったため書き直した）。
 *
 * - `run`: 書き込み文を実行する。
 * - `get`/`all`: 行を読む。該当行が無ければ `get` は `undefined`、`all` は
 *   空配列を返す。
 * - `exec`: パラメータの無い複数文をまとめて実行する（マイグレーション用。
 *   `PRAGMA` の設定もここで行う）。`pragma` 専用の口は設けない
 *   （plugin-sql には `pragma` の API が無いため。`PRAGMA` の値の読み出しは
 *   `get`/`all` で行う）。
 * - `transaction`: 下記参照。
 */
export interface Db {
  run(sql: string, params?: SqlValue[]): Promise<RunResult>;
  get<T = unknown>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: SqlValue[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /**
   * `fn` を1つのトランザクションとして実行し、その戻り値を返す。
   *
   * - トップレベルの `DbPort.transaction` は、直列化層の非同期ロックを
   *   取ってから `BEGIN IMMEDIATE` → `fn(tx)` → `COMMIT`（例外なら
   *   `ROLLBACK`）を行う。ロックが解放されるまで、他の流れの DB 操作は
   *   すべて待たされる。
   * - `DbTx.transaction`（入れ子）は同じロックを再取得せず、`SAVEPOINT` /
   *   `RELEASE` / `ROLLBACK TO` で合成する。
   * - **`fn` の中では、引数として渡された `tx` だけを使うこと。** 症状は
   *   呼び先によって異なる（self-review・code-reviewer/design-reviewer
   *   双方が独立に指摘・実装ベースで検証済み。self-review は2周を要した
   *   ——1周目で入れた「同じ `tx` への呼び出しをキューで直列化する」修正が、
   *   2周目のレビューで**接続全体を巻き込むデッドロック**を生んでいると
   *   指摘され、「待たせず即座に例外にする」設計へ直した）:
   *   - 外側の `DbPort`（トップレベルのポート）を `fn` の中から呼ぶと、
   *     直列化層のロックを二重に取ろうとして**待ち続ける（デッドロック）**。
   *   - さらに外側の `tx`（祖先の `tx`）を `fn` の中から呼んだ場合は、
   *     待たされずに**即座に例外になる**——祖先の `tx` は「自分自身の入れ子
   *     `transaction(fn)` を実行中（busy）」の間、他の呼び出し（祖先の
   *     `tx` からの呼び出しを含む）をすべて即座に拒否する。
   *   - 同じ `tx` から2つ目の `tx.transaction(...)` を、1つ目を `await`
   *     せず並行に張った場合も同様に、2つ目は SAVEPOINT を一切張らずに
   *     即座に例外になる。1つ目は影響を受けず、自分の `SAVEPOINT`〜
   *     `RELEASE`／`ROLLBACK TO` をそのまま進める。
   *   - **既知の制約（S1 の同期ドライバでは再現しない。self-review 3周目・
   *     code-reviewer 指摘・CONFIRMED）**: `fn` が `Promise.all`（
   *     `allSettled` ではなく）でこの2つを張ると、`Promise.all` は2つ目の
   *     即時拒否ですぐ reject するため、非同期ドライバ（S2 の plugin-sql）
   *     の下では `fn` が1つ目の完了を待たずに例外を投げて戻りうる。この
   *     状態で親（`fn` の呼び出し元）がそのまま `COMMIT`／`ROLLBACK` へ
   *     進むと、まだ実行中の1つ目の文が親の後始末と同じ接続の上で入り
   *     混じる恐れがある。親に「待ち合わせ」を足す修正を試したが、`fn` が
   *     返す Promise がバグにより永久に解決しない場合に接続全体が恒久的に
   *     ハングする、より悪い退行を生んだため見送った（`serialized-db.ts`
   *     の `TxState.busy` の JSDoc に経緯を記す）。**この窓を避けるには、
   *     同じ `tx` から複数の入れ子トランザクションを張るときは
   *     `Promise.all` ではなく1つずつ `await` すること**（並行に張りたい
   *     ことがそもそも稀であり、S1 の対象ドライバでは実害が無い）。
   *   入れ子の箇所で `tx` を引き回していることは、コードレビューの確認
   *   項目にする（機能仕様・決定1）。
   * - **入れ子の `tx.transaction(fn)` の呼び出しは、必ず `await` して
   *   `fn` から返すこと。** `await` せずに返す（内側のトランザクションを
   *   漏らす）と、外側が `COMMIT`／`ROLLBACK` してロックを解放した後も
   *   内側の `tx` を使おうとする経路が生まれる。そのような漏れた `tx` は
   *   使用時に例外になる（下記）。
   * - **判定に使う読み出しも含め、DB 操作だけを `fn` の中で行うこと。**
   *   LLM の呼び出し・通知の送信・ファイル操作等、DB 以外の長い `await`
   *   は `fn` の中に入れない（直列化層のロックをその間ずっと握ったままに
   *   しないため。機能仕様「クリティカル設計決定2」）。判定と書き込みだけ
   *   を `fn` で確定させ、その結果を見て `fn` の外（`transaction` の
   *   呼び出し元）で LLM 呼び出し等を行う。
   * - `fn` が投げた例外（拒否された Promise を含む）は、`ROLLBACK`
   *   （入れ子なら `ROLLBACK TO`／`RELEASE`）とロックの解放を行った後、
   *   **同じ例外オブジェクトのまま**呼び出し元へ投げ直す（包み直さない・
   *   握りつぶさない。後始末自体が失敗しても、この例外オブジェクトを
   *   優先する）。
   * - `transaction` が解決（成功・失敗いずれも）した後、その呼び出しで
   *   `fn` に渡された `tx` を使おうとすると例外になる（漏れた `tx` の
   *   誤用を早く落とすため。祖先の `tx`／`transaction` が先に解決した
   *   場合も同様に例外になる）。
   */
  transaction<T>(fn: (tx: DbTx) => Promise<T> | T): Promise<T>;
}

/** トップレベルの非同期 DB ポート。`Db` と同じ操作を持つ（{@link Db} 参照）。 */
export type DbPort = Db;

/** `transaction(fn)` の中で `fn` に渡されるハンドル。`Db` と同じ操作を持つ
 * （{@link Db} 参照）。 */
export type DbTx = Db;

/**
 * ドライバの契約。直列化層（`serialized-db.ts`）が呼び出す、**1本の接続の
 * 上で文を実行するだけ**の薄い層。ロック・トランザクションの意味（SAVEPOINT
 * の合成、ロールバック時の例外の投げ直し等）はドライバの責務ではなく直列化
 * 層が持つ——ドライバはここに書かれた文をそのまま実行するだけでよい。
 *
 * 各メソッドは同期・非同期どちらの実装でもよい（開発者用の版の
 * better-sqlite3 実装は同期、製品版の plugin-sql 実装〔S2〕は非同期になる
 * 見込み）。
 */
export interface DbDriver {
  run(sql: string, params?: SqlValue[]): RunResult | Promise<RunResult>;
  get<T = unknown>(sql: string, params?: SqlValue[]): (T | undefined) | Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: SqlValue[]): T[] | Promise<T[]>;
  exec(sql: string): void | Promise<void>;
}
