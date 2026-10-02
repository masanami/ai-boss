// self-review（design-reviewer, PLAUSIBLE）: 製品版のコアへの唯一の公開面は
// `server/src/core-entry.ts`（機能仕様「用語」・仮定 A3。S1 のバンドル検査
// `core-entry.bundle.test.ts` の起点でもある）。`core-app.js` を直接 import
// すると、この入口を迂回する経路が増える。ここでは `core-entry.ts` から
// re-export された `createCoreApp` を使う（値 import はこれだけ。`Hono` の
// 戻り値の型は `createCoreApp` の宣言から推論させ、`hono` を明示的に
// import しない — web/package.json に `hono` を宣言していないため）。
import { createCoreApp, type DbPort } from "../../../server/src/core-entry.js";
import { createPluginFsEvidenceStore } from "./plugin-fs-evidence-store";

/**
 * 製品版の web のエントリが組み立てる Hono アプリ（機能仕様
 * docs/features/tauri-in-app-runtime.md S2「LLM」・
 * docs/features/async-db-layer.md「S2 の設計」）。
 *
 * - DB は、製品版の DB 実装（plugin-sql・`product-db.ts`）か、その準備に
 *   失敗したときの「DB 未接続」ポート（`disconnected-db-port.ts`）を受け取る
 *   （選ぶのは `boot-product-app.ts`）。
 * - 証跡ファイルの保存は plugin-fs 実装（`plugin-fs-evidence-store.ts`・#579 S4）。
 *   保存先はアプリのデータディレクトリの `evidence/`。DB が「未接続」のときも
 *   同じ実装を渡す（DB を使うルートが先に失敗するため、保存先には触れない）。
 * - `env` は空（`process.env` を読まない。このモジュールから到達可能な
 *   コードは Node 組み込みを参照しない — `core-app.ts` 自身が
 *   `core-entry.bundle.test.ts` でバンドル検査済み）。
 * - LLM バックエンドは 1 つも登録しない（オーナーの決定 Q4-c）。
 *   `createCoreApp` はバックエンドを登録する側ではなく、登録済みレジストリ
 *   （`llm/llm-backend-registry.ts`）を参照するだけなので、このモジュールを
 *   呼ぶだけではどのバックエンドも登録されない（登録は `product-llm.ts`）。
 * - LLM の選択の保存の入口 `/api/llm-selection` を有効にする（#582 S2。
 *   開発者用の版は有効にしない）。
 * - 催促の予約の計画し直しの契機（#585 S3・docs/features/scheduled-nudges.md
 *   「製品版のエントリの配線」）: iOS のときだけ `boot-product-app.ts` が
 *   `onStateChangingRequest` を渡し、`createCoreApp` の同名の引数へそのまま
 *   渡す（`/api` の GET・HEAD・OPTIONS 以外の要求の後に呼ばれる。仮定 A20）。
 *   macOS は渡さない（毎分方式のまま）。
 */
export interface ProductCoreAppOptions {
  onStateChangingRequest?: () => void;
}

export function createProductCoreApp(db: DbPort, options: ProductCoreAppOptions = {}) {
  // 選択の入口（`GET`・`PUT /api/llm-selection`）は製品版だけが有効にする（#582 S2）。
  // DB が「未接続」のときも有効にする（DB を読む時点で失敗する。仮定 A20）。
  return createCoreApp(
    db,
    {},
    {
      evidenceStore: createPluginFsEvidenceStore(),
      llmSelectionApi: true,
      onStateChangingRequest: options.onStateChangingRequest,
    },
  );
}

export type ProductCoreApp = ReturnType<typeof createProductCoreApp>;
