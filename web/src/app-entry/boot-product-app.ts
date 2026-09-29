import type { DbPort } from "../../../server/src/core-entry.js";
import { createProductCoreApp, type ProductCoreApp } from "./create-product-core-app";
import { createDisconnectedDbPort } from "./disconnected-db-port";

/**
 * 製品版の web のエントリの起動の順序（#580 S2・機能仕様
 * docs/features/async-db-layer.md「S2 の設計」・受入基準（S2）AC-S2-24・25）。
 *
 * 1. DB を準備する（plugin-sql 実装のポートを組み、マイグレーションする）。
 *    失敗したら「DB 未接続」ポートにフォールバックし、失敗を記録する
 *    （起動は止めない。画面は #579 S2 の器と同じく DB を使う部分がエラーの
 *    表示になる。仮定 A7）。
 * 2. 準備が済んでから、そのポートでコアのアプリを組み、`/api` を振り向ける。
 * 3. 画面を描画する。
 * 4. 毎分の検知を始める（#579 S3・機能仕様 docs/features/tauri-in-app-runtime.md
 *    「起動の順序」・AC-S3-30〜33）。**DB の準備に成功したときだけ**始める
 *    （「DB 未接続」ポートを読む刻みはすべて失敗するため）。購読の開始が失敗・
 *    未解決でも画面は描画済み（描画を止めない）で、失敗は記録する。
 *
 * 準備が終わる前に `/api` を振り向けない（マイグレーションの途中の DB を
 * ルートに触らせない）。
 */
export interface BootProductAppDeps {
  openDb: () => Promise<DbPort>;
  logError: (message: string, error: unknown) => void;
  installApi: (app: ProductCoreApp) => void;
  render: () => void;
  /** 準備した DB のポートで毎分の検知を始める（`start-product-scheduler.ts`）。 */
  startScheduler: (db: DbPort) => Promise<void>;
}

export const PRODUCT_DB_OPEN_FAILED_MESSAGE =
  "製品版の DB を準備できませんでした（DB 未接続として起動します）";

export const PRODUCT_SCHEDULER_START_FAILED_MESSAGE =
  "製品版の毎分の検知を始められませんでした（催促は届きません）";

export async function bootProductApp(deps: BootProductAppDeps): Promise<void> {
  let db: DbPort;
  let dbReady = true;
  try {
    db = await deps.openDb();
  } catch (error) {
    deps.logError(PRODUCT_DB_OPEN_FAILED_MESSAGE, error);
    db = createDisconnectedDbPort();
    dbReady = false;
  }
  deps.installApi(createProductCoreApp(db));
  deps.render();

  if (!dbReady) return;
  try {
    await deps.startScheduler(db);
  } catch (error) {
    deps.logError(PRODUCT_SCHEDULER_START_FAILED_MESSAGE, error);
  }
}
