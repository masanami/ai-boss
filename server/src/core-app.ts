import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createTasksRouter } from "./tasks/tasks-routes.js";
import { createSessionsRouter } from "./sessions/sessions-routes.js";
import { createActivityRouter } from "./activity/activity-routes.js";
import { createCheckinsRouter } from "./activity/checkins-routes.js";
import { createDecisionsRouter } from "./decisions/decisions-routes.js";
import { createDashboardRouter } from "./dashboard/dashboard-routes.js";
import { createReportsRouter } from "./reports/reports-routes.js";
import { createWorkLogsRouter } from "./reports/work-logs-routes.js";
import { createSettingsRouter } from "./settings/settings-routes.js";
import { createMeetingScheduleRouter } from "./meeting-schedule/meeting-schedule-routes.js";
import { resolveLlmBackend, type LlmBackend, type AppEnv } from "./config.js";
import type { EvidenceStore } from "./tasks/evidence-store.js";

/**
 * `server/src` を「実行環境に依存しないコア」と「Node の周辺」に分ける
 * リファクタ（機能仕様 docs/features/tauri-in-app-runtime.md「機能全体の
 * 設計」・実装計画③）の中心。このモジュールは Node 組み込み（`node:*`）・
 * `process`・`@hono/node-server`・Agent SDK・`@anthropic-ai/sdk` を値として
 * import しない — `server/src/core-entry.bundle.test.ts` がバンドル検査で
 * 固定する。
 *
 * 旧 `app.ts` の `/api` ルート組み立てをここへ移した。`app.ts`（開発者用の
 * 版・Node 周辺）は、LLM バックエンドの登録（`registerDevLlmBackends`）・
 * 証跡ファイルの Node fs 実装（`createNodeFsEvidenceStore`）・静的配信
 * （`@hono/node-server/serve-static`）を足してからこの `createCoreApp` を
 * 呼ぶ。
 */

function checkDatabaseConnection(db: Database.Database): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export interface CreateCoreAppOptions {
  /**
   * LLM backend threaded through to the chat route only (`sessions` →
   * `createSessionsRouter`, self-review: design-reviewer corrected this doc
   * — `decisions` is read-only and never took a backend; the previous
   * wording listing it was stale). Unlike the old `app.ts`'s
   * `CreateAppOptions.llmBackend`, this has no implicit `process.env`
   * fallback path baked into a default parameter — callers that omit it get
   * `resolveLlmBackend(env)` (this function's own `env` argument, which is
   * required, not `process.env`). Production caller: `app.ts`'s `createApp`
   * (開発者用の版, passes `loadConfig(env).llmBackend`). The product entry
   * (`core-entry.ts`) only re-exports this function — it never calls it
   * itself — but if a future caller did pass a backend through here while
   * none is registered (製品版のコアはどのバックエンドも登録しない —
   * オーナーの決定 Q4-c), `createClaudeClient` would raise
   * `LlmBackendNotRegisteredError`, which the chat route's existing generic
   * `Error` catch already turns into an HTTP 500.
   *
   * **Not wired to every LLM-using route** (unchanged from `app.ts`'s
   * pre-refactor behavior — self-review: design-reviewer flagged this as
   * worth restating here since the previous explanatory paragraph lived in
   * `app.ts` and was dropped when this file split off it, then flagged a
   * second time, 2周目, that the restated list itself named the wrong
   * modules — corrected below):
   * - `sessions/meeting-opening.ts` and `dashboard/boss-comment.ts` /
   *   `notifications/notification-body.ts` / `reports/generate-daily-
   *   report.ts` (via `reports/extract-evening-summary.ts`) resolve the
   *   backend themselves via `resolveLlmBackend(env)` (Issue #79),
   *   independent of this option.
   * - `sessions/session-summary.ts` is **not** in that self-resolving list
   *   (self-review correction, 2周目) — it takes `llmBackend` as an explicit
   *   parameter from `createSessionsRouter` (`sessions/sessions-routes.ts`),
   *   so it *does* respect this option, same as the chat route.
   * - `notifications/notification-body.ts` is reached only through the
   *   scheduler (`index.ts`'s `startScheduler` → `scheduler-tick.ts`), never
   *   through any router this function builds — "they already receive the
   *   full `env` this function passes their router constructors" (an
   *   earlier version of this paragraph) does not apply to it; it receives
   *   `env` from the scheduler wiring instead.
   *
   * This means a caller that wants every LLM-using code path on one
   * non-default backend must still rely on `env.LLM_BACKEND`, not this
   * option alone.
   */
  llmBackend?: LlmBackend;
  /**
   * Evidence file byte storage port (機能仕様
   * docs/features/tauri-in-app-runtime.md「機能全体の設計」実装計画②).
   * `undefined` in most tests that don't touch the evidence file endpoints —
   * those endpoints answer `500` if actually invoked without one (see
   * `tasks/task-evidences-routes.ts`), rather than throwing an unhandled
   * exception.
   */
  evidenceStore?: EvidenceStore;
}

/**
 * Creates the Hono application. Routes are namespaced under `/api`.
 *
 * `env` is a required argument (no `process.env` default — 機能仕様
 * docs/features/tauri-in-app-runtime.md 実装計画②「process.env の既定引数の
 * 除去」) so that this module never references the Node global `process`,
 * even in a default-parameter expression that a caller who always supplies
 * `env` would never actually evaluate (Issue #594 のコメント P2:
 * 遅延評価であっても識別子としての混入を避ける). Every router that needs
 * Claude client resolution — sessions (chat and session summary) and
 * dashboard (boss comment) — receives it explicitly (self-review:
 * design-reviewer, 2周目 — `decisions` was removed from this list; it is
 * read-only and never took `env`/a backend, see `CreateCoreAppOptions.
 * llmBackend`'s doc comment above).
 */
export function createCoreApp(
  db: Database.Database,
  env: AppEnv,
  options: CreateCoreAppOptions = {},
): Hono {
  const api = new Hono();
  const llmBackend: LlmBackend = options.llmBackend ?? resolveLlmBackend(env);

  api.get("/health", (c) => {
    return c.json({ status: "ok", db: checkDatabaseConnection(db) });
  });

  api.route("/tasks", createTasksRouter(db, options.evidenceStore));
  api.route("/sessions", createSessionsRouter(db, env, llmBackend));
  api.route("/checkins", createCheckinsRouter(db));
  api.route("/activity", createActivityRouter(db));
  api.route("/decisions", createDecisionsRouter(db));
  api.route("/dashboard", createDashboardRouter(db, env));
  api.route("/reports", createReportsRouter(db, env));
  api.route("/work-logs", createWorkLogsRouter(db));
  api.route("/settings", createSettingsRouter(db));
  api.route("/meeting-schedule", createMeetingScheduleRouter(db));

  const app = new Hono();
  app.route("/api", api);

  return app;
}
