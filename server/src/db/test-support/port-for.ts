import type Database from "better-sqlite3";
import type { Db, DbPort, DbTx } from "../db-port.js";
import { createBetterSqlite3Port } from "../connection.js";

/**
 * テスト専用の補助（#597 の移行期の橋渡し `transitional-bridge.ts` を、合成
 * ルートのポート化〔#607〕の後にテスト補助として残したもの。製品コードからは
 * import しない — AC-1 の import 走査テストが固定する）。
 *
 * `portFor(raw)` は、テストが `openDatabase(":memory:")` で開いた生の接続に
 * 対し、常に同じ直列化済みポート（＝同じロック）を返す。テストはこのポートを
 * `createApp` やリポジトリへ渡し、検証のための直接の読み書きには生の接続を
 * 使ってよい（機能仕様の仮定 A1）。`rawOf(db)` はポート／`tx`（入れ子を含む）
 * から生の接続を取り出す。`trackPort(port, raw)` はフック付きのテスト用ポート
 * を `raw` のポートとして登録する（`create-test-db.ts` の `createHookedTestDb`）。
 *
 * **生の接続へ、ポートのトランザクションの外から並行に書き込まないこと** ——
 * そのトランザクションが await の途中なら、黙ってそのトランザクションに
 * 混ざり、ロールバックで一緒に消える（機能仕様の実測）。`rawOf(tx)` は、その
 * `tx` の `fn` の中で・同期的に使うときに限る（終了済みの `tx` かどうかは
 * 確認しない）。
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

/**
 * Registers an already built serialized port (e.g. one on a hooked test
 * driver — `create-test-db.ts`'s `createHookedTestDb`) as *the* port for
 * `raw`, so that `rawOf` works on it and `portFor(raw)` returns this same
 * port (same lock, same hooks) instead of building a second one (#605).
 */
export function trackPort(port: DbPort, raw: Database.Database): DbPort {
  const tracked = registerRawTracking(port, raw) as DbPort;
  portCache.set(raw, tracked);
  return tracked;
}
