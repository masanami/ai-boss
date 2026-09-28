import { openDatabase, createBetterSqlite3Port } from "./connection.js";
import { describeDbPortContract } from "./test-support/db-port-contract.js";

/**
 * 両版で同じ契約スイートを、開発者用の版（better-sqlite3 実装・`:memory:`）で
 * 回す（#580 S2・機能仕様 docs/features/async-db-layer.md 受入基準（S2）
 * AC-S2-13〜21）。製品版（plugin-sql 実装）では同じ本体を
 * `web/tauri-db/`（`npm run test:tauri-db`）が回す。
 */
describeDbPortContract("better-sqlite3", async () => {
  const raw = openDatabase(":memory:");
  return {
    db: createBetterSqlite3Port(raw),
    close: () => {
      raw.close();
    },
  };
});
