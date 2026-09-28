// self-review（design-reviewer, PLAUSIBLE）: 製品版のコアへの唯一の公開面は
// `server/src/core-entry.ts`（機能仕様「用語」・仮定 A3。S1 のバンドル検査
// `core-entry.bundle.test.ts` の起点でもある）。`core-app.js` を直接 import
// すると、この入口を迂回する経路が増える。ここでは `core-entry.ts` から
// re-export された `createCoreApp` を使う（値 import はこれだけ。`Hono` の
// 戻り値の型は `createCoreApp` の宣言から推論させ、`hono` を明示的に
// import しない — web/package.json に `hono` を宣言していないため）。
import { createCoreApp } from "../../../server/src/core-entry.js";
import { createDisconnectedDbPort } from "./disconnected-db-port.js";

/**
 * 製品版の web のエントリが組み立てる Hono アプリ（機能仕様
 * docs/features/tauri-in-app-runtime.md S2「DB 未接続の間の振る舞い」・
 * 「LLM」）。
 *
 * - DB は S2 の「DB 未接続」ポート（`createDisconnectedDbPort`）を渡す
 *   （#580 S2 でこのポートを製品版の DB 実装に差し替える）。
 * - `env` は空（`process.env` を読まない。このモジュールから到達可能な
 *   コードは Node 組み込みを参照しない — `core-app.ts` 自身が
 *   `core-entry.bundle.test.ts` でバンドル検査済み）。
 * - LLM バックエンドは 1 つも登録しない（オーナーの決定 Q4-c）。
 *   `createCoreApp` はバックエンドを登録する側ではなく、登録済みレジストリ
 *   （`llm/llm-backend-registry.ts`）を参照するだけなので、このモジュールを
 *   呼ぶだけではどのバックエンドも登録されない。
 */
export function createProductCoreApp() {
  return createCoreApp(createDisconnectedDbPort(), {});
}
