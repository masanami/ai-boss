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
 *
 * 最初に `ROLLBACK` を 1 回送り、失敗（開いたトランザクションが無い）は
 * 無視する。Rust 側の接続はアプリのプロセスが続く限り 1 本のまま残るが、
 * 直列化層の状態はページの読み込みごとに作り直される。前のページが
 * `BEGIN IMMEDIATE` の途中で読み込み直されると、残ったトランザクションに
 * 以後の書き込みが黙って混ざり、次の `BEGIN` の失敗の後始末で一緒に消える
 * ため、ここで閉じておく（仮定 A11）。
 */
export async function openProductDb(database: PluginSqlDatabase): Promise<DbPort> {
  await database.execute("ROLLBACK").catch(() => undefined);
  const db = createSerializedDb(createPluginSqlDriver(database));
  await runMigrations(db);
  return db;
}
