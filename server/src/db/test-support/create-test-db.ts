import type Database from "better-sqlite3";
import { openDatabase } from "../connection.js";
import { runMigrations } from "../migrate.js";
import { portFor } from "../transitional-bridge.js";
import type { DbPort } from "../db-port.js";

/**
 * テスト専用の補助（better-sqlite3 に依存してよい。機能仕様
 * docs/features/async-db-layer.md「移行期の共通規約」・#601 完了条件）。
 *
 * マイグレーション済みの `:memory:` DB を組み立てて `{ db, raw }` を返す。
 * `runMigrations` は同期のうちは生の接続（`raw`）に対して直接呼ぶ。
 * `raw` は既存の同期テストコード（`db.prepare`/`exec`/`pragma` を直に呼ぶ
 * 24 ファイル・69 箇所、機能仕様の仮定 A1）が使ってよい。
 */
export function createTestDb(): { db: DbPort; raw: Database.Database } {
  const raw = openDatabase(":memory:");
  runMigrations(raw);
  const db = portFor(raw);
  return { db, raw };
}
