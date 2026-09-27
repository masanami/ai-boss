import type Database from "better-sqlite3";
import { openDatabase } from "../connection.js";
import { runMigrations } from "../migrate.js";
import { portFor, trackPort } from "./port-for.js";
import type { DbPort } from "../db-port.js";
import { createBetterSqlite3Driver } from "../connection.js";
import { createSerializedDb } from "../serialized-db.js";
import { createHookedDriver, type DriverHook } from "./hooked-driver.js";

/**
 * テスト専用の補助（better-sqlite3 に依存してよい。機能仕様
 * docs/features/async-db-layer.md「移行期の共通規約」・#601 完了条件）。
 *
 * マイグレーション済みの `:memory:` DB を組み立てて `{ db, raw }` を返す。
 * `runMigrations`（#602 で非同期の `Db` ポート経由になった）は `portFor(raw)`
 * に対して呼ぶ。`raw` は既存の同期テストコード（`db.prepare`/`exec`/`pragma`
 * を直に呼ぶ 24 ファイル・69 箇所、機能仕様の仮定 A1）が使ってよい。
 */
export async function createTestDb(): Promise<{ db: DbPort; raw: Database.Database }> {
  const raw = openDatabase(":memory:");
  const db = portFor(raw);
  await runMigrations(db);
  return { db, raw };
}

/**
 * Like {@link createTestDb}, but the returned port runs on a hooked driver
 * (`createHookedDriver`) whose hook list is the returned mutable `hooks`
 * array — push hooks *after* creation (migrations run before any hook is
 * registered), and they can reference `db` directly to inject another flow's
 * operation right after a matching statement, or throw to make that
 * statement fail (#603).
 *
 * All DB access in such a test must go through this `db`: `portFor(raw)` is
 * a *different* port (different lock, no hooks).
 */
export async function createHookedTestDb(): Promise<{
  db: DbPort;
  raw: Database.Database;
  hooks: DriverHook[];
}> {
  const raw = openDatabase(":memory:");
  const hooks: DriverHook[] = [];
  const db = trackPort(
    createSerializedDb(createHookedDriver(createBetterSqlite3Driver(raw), hooks)),
    raw,
  );
  await runMigrations(db);
  return { db, raw, hooks };
}
