import Database from "@tauri-apps/plugin-sql";
import { createSerializedDb, runMigrations, type DbPort } from "../../../server/src/core-entry.js";
import { createPluginSqlDriver, type PluginSqlDatabase } from "./plugin-sql-driver";

/**
 * 製品版の DB（#580 S2・機能仕様 docs/features/async-db-layer.md「S2 の設計」）。
 *
 * DB ファイルを開くのは Rust 側だけ: `tauri.conf.json` の `plugins.sql.preload`
 * が起動時にアプリのデータディレクトリの `ai-boss.db` を開く。WebView は
 * その名前で参照するだけで `load` を呼ばない（capability でも許可していない）。
 */
export const PRODUCT_DB_URL = "sqlite:ai-boss.db";

/** preload 済みの DB を参照する（`Database.get` は IPC を呼ばない）。 */
export function getProductDatabase(): PluginSqlDatabase {
  return Database.get(PRODUCT_DB_URL);
}

/**
 * plugin-sql 実装のドライバの上に S1 の直列化層でポートを組み、`migrate.ts`
 * （`user_version`。クリティカル設計決定 4）でマイグレーションしてから返す。
 */
export async function openProductDb(database: PluginSqlDatabase): Promise<DbPort> {
  const db = createSerializedDb(createPluginSqlDriver(database));
  await runMigrations(db);
  return db;
}
