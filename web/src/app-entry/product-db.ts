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

/** 開いたトランザクションが無いときの `ROLLBACK` の SQLite のエラー文言の一部。 */
const NO_ACTIVE_TRANSACTION = "no transaction is active";

/** preload 済みの DB を参照する（`Database.get` は IPC を呼ばない）。 */
export function getProductDatabase(): PluginSqlDatabase {
  return Database.get(PRODUCT_DB_URL);
}

/**
 * plugin-sql 実装のドライバの上に S1 の直列化層でポートを組み、`migrate.ts`
 * （`user_version`。クリティカル設計決定 4）でマイグレーションしてから返す。
 *
 * 最初に `ROLLBACK` を 1 回送る。Rust 側の接続はアプリのプロセスが続く限り
 * 1 本のまま残るが、直列化層の状態はページの読み込みごとに作り直される。
 * 前のページが `BEGIN IMMEDIATE` の途中で読み込み直されると、残った
 * トランザクションに以後の書き込みが黙って混ざり、次の `BEGIN` の失敗の
 * 後始末で一緒に消えるため、ここで閉じておく（仮定 A11）。
 *
 * 無視する失敗は SQLite の「開いたトランザクションが無い」だけ。それ以外
 * （IPC の失敗など）はトランザクションが閉じたか分からないので投げ、DB の
 * 準備の失敗として「DB 未接続」の起動へ倒す（仮定 A7）。
 */
export async function openProductDb(database: PluginSqlDatabase): Promise<DbPort> {
  await database.execute("ROLLBACK").catch((error: unknown) => {
    if (!String(error).includes(NO_ACTIVE_TRANSACTION)) throw error;
  });
  const db = createSerializedDb(createPluginSqlDriver(database));
  await runMigrations(db);
  return db;
}
