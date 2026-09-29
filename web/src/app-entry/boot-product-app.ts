import type { DbPort } from "../../../server/src/core-entry.js";
import { createProductCoreApp, type ProductCoreApp } from "./create-product-core-app";
import { createDisconnectedDbPort } from "./disconnected-db-port";

/**
 * 製品版の web のエントリの起動の順序（#580 S2・機能仕様
 * docs/features/async-db-layer.md「S2 の設計」・受入基準（S2）AC-S2-24・25）。
 *
 * 0. 製品版の LLM を準備する（BYOK〔Anthropic〕と製品版の解決関数の登録。
 *    #581 S3・機能仕様 docs/features/secure-transport-byok.md 受入基準
 *    （S3）S3-E4: `/api` の振り向けより前）。
 * 1. DB を準備する（plugin-sql 実装のポートを組み、マイグレーションする）。
 *    失敗したら「DB 未接続」ポートにフォールバックし、失敗を記録する
 *    （起動は止めない。画面は #579 S2 の器と同じく DB を使う部分がエラーの
 *    表示になる。仮定 A7）。
 * 2. 準備が済んでから、そのポートでコアのアプリを組み、`/api` を振り向ける。
 * 3. 画面を描画する。
 *
 * 準備が終わる前に `/api` を振り向けない（マイグレーションの途中の DB を
 * ルートに触らせない）。
 */
export interface BootProductAppDeps {
  installLlm: () => void;
  openDb: () => Promise<DbPort>;
  logError: (message: string, error: unknown) => void;
  installApi: (app: ProductCoreApp) => void;
  render: () => void;
}

export const PRODUCT_DB_OPEN_FAILED_MESSAGE =
  "製品版の DB を準備できませんでした（DB 未接続として起動します）";

export async function bootProductApp(deps: BootProductAppDeps): Promise<void> {
  deps.installLlm();
  let db: DbPort;
  try {
    db = await deps.openDb();
  } catch (error) {
    deps.logError(PRODUCT_DB_OPEN_FAILED_MESSAGE, error);
    db = createDisconnectedDbPort();
  }
  deps.installApi(createProductCoreApp(db));
  deps.render();
}
