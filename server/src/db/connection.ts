import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DbDriver, DbPort, RunResult, SqlValue } from "./db-port.js";
import { createSerializedDb } from "./serialized-db.js";

/**
 * Ensures the parent directory of a file-based db path exists. No-op for
 * the special `:memory:` path. `mkdirSync` with `recursive: true` does not
 * throw when the directory already exists, so no existence check is needed.
 */
function ensureParentDirectoryExists(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
}

/**
 * Opens a SQLite connection and enables foreign key enforcement.
 *
 * @param dbPath - Path to the SQLite file, or `:memory:` for an in-memory
 *   database. Default resolution (env var / fallback path) is the
 *   responsibility of the caller (see `config.ts`). The parent directory is
 *   created if it does not exist yet.
 */
export function openDatabase(dbPath: string): Database.Database {
  ensureParentDirectoryExists(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

// ---------------------------------------------------------------------------
// better-sqlite3 実装（#597 AC-1: 製品コードで better-sqlite3 を import するのは
// このモジュールだけ。Node の周辺＝開発者用の版とテストだけが使い、製品版の
// コアのバンドルには入らない）。
// ---------------------------------------------------------------------------

/**
 * better-sqlite3 は**型としてのみ** import する（値としては import しない
 * — 実際の生の接続 `raw` は呼び出し元が用意して渡す。「Node の周辺」の
 * モジュールとして、コアのバンドル検査
 * `server/src/core-entry.bundle.test.ts` の対象外にする設計
 * ・機能仕様 docs/features/async-db-layer.md）。
 *
 * 1本の接続 `raw` の上で文を実行するだけの {@link DbDriver} 実装。ロック・
 * トランザクションの意味は持たない（直列化層 `serialized-db.ts` の責務）。
 */
export function createBetterSqlite3Driver(raw: Database.Database): DbDriver {
  return {
    run(sql: string, params: SqlValue[] = []): RunResult {
      const info = raw.prepare(sql).run(...params);
      return {
        changes: info.changes,
        // better-sqlite3 は `lastInsertRowid` を `number | bigint` で返す
        // （大きな rowid のときだけ bigint）。ポートの契約は number に統一
        // する（機能仕様「IF / API」節）。
        lastInsertRowid: Number(info.lastInsertRowid),
      };
    },
    get<T = unknown>(sql: string, params: SqlValue[] = []): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T = unknown>(sql: string, params: SqlValue[] = []): T[] {
      return raw.prepare(sql).all(...params) as T[];
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
  };
}

const portsByRawConnection = new WeakMap<Database.Database, DbPort>();

/**
 * `raw`（better-sqlite3 の生の接続）1本の上に、直列化された非同期の
 * {@link DbPort} を組み立てる。開発者用の版の唯一の DB 生成経路になる想定
 * （#601 時点では既存呼び出し元からはまだ使われない）。
 *
 * **同じ `raw` に対しては、常に同じ `DbPort`（＝同じ直列化ロック）を返す**
 * （`raw` ごとに `WeakMap` でキャッシュする）。この保証が無いと、ある経路が
 * `createBetterSqlite3Port(raw)` を、別の経路（`transitional-bridge.ts` の
 * `portFor(raw)` 等）が独立にポートを作った場合に、同じ接続の上に別々の
 * ロックが2本できてしまい、決定1の「直列化層でトランザクションを1つずつ
 * 通す」が黙って崩れる（self-review・design-reviewer 指摘・CONFIRMED相当:
 * `portFor` はこのキャッシュに乗るため、`portFor` 経由と直接呼び出しを
 * 混在させても同じロックになる）。
 */
export function createBetterSqlite3Port(raw: Database.Database): DbPort {
  const cached = portsByRawConnection.get(raw);
  if (cached) {
    return cached;
  }

  const port = createSerializedDb(createBetterSqlite3Driver(raw));
  portsByRawConnection.set(raw, port);
  return port;
}
