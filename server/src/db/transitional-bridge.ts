import type Database from "better-sqlite3";
import type { Db, DbPort, DbTx } from "./db-port.js";
import { createBetterSqlite3Port } from "./better-sqlite3-driver.js";

/**
 * 移行期のみの橋渡し（**最終チケットで削除する**。機能仕様
 * docs/features/async-db-layer.md「移行期の共通規約」）。
 *
 * `portFor(raw)` は同じ生の接続には常に同じ直列化済みポート（＝同じロック）
 * を返す。`rawOf(db)` はポート／`tx`（入れ子を含む）から生の接続を取り出す。
 *
 * `rawOf(tx)` は、未移行の同期コードをトランザクション中に呼ぶ移行期の用途
 * で使う——同じ接続上ですでに `BEGIN`（または `SAVEPOINT`）済みなので、その
 * 同期コードが `rawOf(tx)` に対して行う書き込みはそのトランザクションに
 * 含まれる。
 *
 * **`rawOf(tx)` は、その `tx` の `fn` の中で・同期的に使うときに限ること。**
 * `rawOf` 自身は `tx` が既に終了しているか（`transaction(fn)` が解決済みか）
 * を確認しない（self-review・code-reviewer/design-reviewer 双方が独立に
 * 指摘。`serialized-db.ts` の各操作が持つ「終了後の `tx` の使用は例外」の
 * チェックを `rawOf` は経由しないため）。`fn` の外で `rawOf(tx)` の戻り値を
 * 保持して後から書き込むと、直列化層のロックの外（オートコミット、または
 * 無関係な後続の操作の最中）に書き込みが実行される。同様に、`rawOf(port)`
 * で取り出した生の接続へ、トランザクションの外から並行に書き込まない
 * こと——そのトランザクションが実行中なら、機能仕様の実測どおり黙って
 * そのトランザクションに混ざり、ロールバックで一緒に消える。
 */

const portCache = new WeakMap<Database.Database, DbPort>();
const rawRegistry = new WeakMap<Db, Database.Database>();

/**
 * `db`（トップレベルのポート、または `transaction(fn)` が `fn` に渡した
 * `tx`。入れ子の `tx` も含む）を、`registry` に `raw` と結び付けて登録した
 * うえで返す。`db.transaction` を薄くラップし、`fn` に渡ってくる（入れ子を
 * 含む）すべての `tx` を再帰的に同じ `raw` へ登録する。
 */
function registerRawTracking(db: Db, raw: Database.Database): Db {
  // 登録するのは（`fn` へ実際に渡る）この関数が返す `wrapped` 自身であって、
  // 元の `db`（serialized-db.ts が作った素の tx）ではない — 呼び出し側は
  // `wrapped` に対して `rawOf` を呼ぶため。
  const wrapped: Db = {
    run: (sql, params) => db.run(sql, params),
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) =>
      db.transaction((tx) => {
        const trackedTx = registerRawTracking(tx, raw);
        return fn(trackedTx);
      }),
  };
  rawRegistry.set(wrapped, raw);
  return wrapped;
}

/**
 * 生の接続 `raw` から直列化済みの {@link DbPort} を得る。同じ `raw` に対して
 * 呼べば、以後は常に同じポート（＝同じロック）を返す。
 */
export function portFor(raw: Database.Database): DbPort {
  const cached = portCache.get(raw);
  if (cached) {
    return cached;
  }

  const port = registerRawTracking(createBetterSqlite3Port(raw), raw) as DbPort;
  portCache.set(raw, port);
  return port;
}

/**
 * `portFor` で得た {@link DbPort} または、その `transaction(fn)` が `fn` に
 * 渡した {@link DbTx}（入れ子を含む）から、元の生の接続を取り出す。
 * `portFor` を経由していないオブジェクトを渡すと例外になる。
 */
export function rawOf(db: DbPort | DbTx): Database.Database {
  const raw = rawRegistry.get(db);
  if (!raw) {
    throw new Error(
      "rawOf: the given DbPort/DbTx was not created via portFor(); its underlying raw connection is unknown",
    );
  }
  return raw;
}
