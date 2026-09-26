import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createCoreApp } from "./core-app.js";
import { createNodeFsEvidenceStore } from "./tasks/evidence-storage.js";
import { registerDevLlmBackends } from "./llm/dev-llm-backends.js";
import type { LlmBackend } from "./config.js";

/**
 * 開発者用の版（現行の Node サーバー版）の合成ルート（機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」・実装計画①②③）。
 * `createCoreApp`（実行環境に依存しないコア）へ、Node 周辺の実装
 * （`claude-code`/`api` の LLM バックエンド登録・証跡ファイルの Node fs
 * 実装・`@hono/node-server/serve-static` による静的配信）を注入する。
 *
 * 製品版のコアのエントリ（`core-entry.ts`）はこのファイルを一切参照しない
 * — `registerDevLlmBackends`（`claude-code` を含む）を呼ぶのはこのファイル
 * と（必要なら）`index.ts` だけで、製品版には含まれない（オーナーの決定
 * Q4-b・Q4-c）。
 */

export interface CreateAppOptions {
  /**
   * Directory of the built web frontend (`web/dist`). When set, its files are
   * served on the same origin as `/api`, with an SPA fallback to `index.html`
   * for unknown non-API paths. When omitted (dev / tests), the app serves the
   * API only and the Vite dev server handles the frontend.
   */
  staticRoot?: string;
  /**
   * LLM backend for the chat and session-summary routes (`sessions`),
   * resolved by the caller via `loadConfig(env).llmBackend` (`index.ts`) and
   * threaded through to `createCoreApp`. When omitted (most tests), it is
   * resolved from `env` via `resolveLlmBackend(env)` inside `createCoreApp`
   * — i.e. the caller's own `LLM_BACKEND`, falling back to `config.ts`'s
   * `DEFAULT_LLM_BACKEND` when that is unset. See
   * `CreateCoreAppOptions.llmBackend`'s doc comment (`core-app.ts`) for which
   * routes this option does and does not reach — `decisions` is read-only
   * and never took a backend (self-review correction, 2周目: an earlier
   * version of this doc comment listed it).
   */
  llmBackend?: LlmBackend;
  /**
   * Directory where task evidence files (attachments) are stored on disk
   * (機能仕様 docs/features/completion-evidence-enforcement.md 決定 1-a).
   * `index.ts` passes `resolveEvidenceDir(config.dbPath)` (`config.ts`), while
   * tests pass a temp directory directly. Converted to an `EvidenceStore`
   * (`tasks/evidence-storage.ts`'s `createNodeFsEvidenceStore`) before being
   * threaded through to `createCoreApp` — the core no longer accepts a raw
   * directory path (機能仕様 docs/features/tauri-in-app-runtime.md 実装計画②）.
   */
  evidenceDir?: string;
}

/**
 * Creates the Hono application. Routes are namespaced under `/api`.
 *
 * `env` defaults to `process.env` and is threaded through explicitly (so
 * tests can inject a fake environment without mutating global state) to
 * `createCoreApp`, which in turn threads it to every router that needs
 * Claude client resolution: sessions (chat and session summary) and
 * dashboard (boss comment) — see `core-app.ts`'s doc comment for the full,
 * corrected accounting (`decisions` never took `env`; self-review, 2周目).
 * This default is safe here (unlike the old
 * `createDashboardRouter`/`createReportsRouter` defaults removed in this same
 * change) because `app.ts` is Node-only periphery, never part of the
 * browser-bundled core (`core-entry.ts`) — see `core-app.ts`'s doc comment.
 */
export function createApp(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
  options: CreateAppOptions = {},
): Hono {
  // 開発者用の版だけが `claude-code`/`api` を登録する（オーナーの決定
  // Q4-b・Q4-c）。レジストリはモジュールレベルのグローバル状態なので、複数
  // テストで `createApp` を繰り返し呼んでも安全（`Map#set` の冪等性）。
  registerDevLlmBackends();

  // `evidenceDir` 省略時は `evidenceStore` を渡さない（`undefined`）—
  // コア（`tasks/task-evidences-routes.ts`）の「evidenceStore 未設定なら
  // 500」という一本化された経路に乗せる。以前は空文字列を Node fs 実装へ
  // 渡していたため、実際にファイル evidence エンドポイントを呼ぶと
  // `mkdirSync("")` が ENOENT を投げて未処理例外になっていた
  // （self-review: code-reviewer/design-reviewer 双方が CONFIRMED/PLAUSIBLE
  // — どのテストにも依存されていない経路だが、コアが新設した「未設定」の
  // 扱いが2通り併存するのは避ける）。
  const evidenceStore = options.evidenceDir
    ? createNodeFsEvidenceStore(options.evidenceDir)
    : undefined;

  const app = createCoreApp(db, env, {
    llmBackend: options.llmBackend,
    evidenceStore,
  });

  if (options.staticRoot) {
    const { staticRoot } = options;
    const serveIndexHtml = serveStatic({ path: join(staticRoot, "index.html") });

    app.use("*", serveStatic({ root: staticRoot }));
    app.get("*", async (c, next) => {
      // Unknown API paths must stay 404 for clients; the SPA fallback is only
      // for frontend routes handled by React on the client side.
      if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
        return c.notFound();
      }
      return (await serveIndexHtml(c, next)) ?? c.notFound();
    });
  }

  return app;
}
