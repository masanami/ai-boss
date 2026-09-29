import { Hono } from "hono";
import type { DbPort } from "./db/db-port.js";
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
import type { AppEnv } from "./config.js";
import type { EvidenceStore } from "./tasks/evidence-store.js";
import { takeDeferredStateChange } from "./state-change-notice.js";

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

/** 状態を変えない要求（計画し直しの契機にしない） */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function checkDatabaseConnection(db: DbPort): Promise<boolean> {
  try {
    await db.get("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export interface CreateCoreAppOptions {
  // 2026-09-29（#581 S3・機能仕様 docs/features/secure-transport-byok.md
  // クリティカル設計決定 7）: `llmBackend` の引数は削除した。LLM を使う
  // 経路（チャット・セッションの要約・朝会の開始の発言・夕会の要約抽出・
  // ダッシュボードのひとこと）は、要求ごとに選択の解決関数
  // （`llm/llm-selection.ts`。エントリが登録し、無ければ開発者用の
  // `LLM_BACKEND` による決め方）でバックエンドとモデルを決める。
  /**
   * Evidence file byte storage port (機能仕様
   * docs/features/tauri-in-app-runtime.md「機能全体の設計」実装計画②).
   * `undefined` in most tests that don't touch the evidence file endpoints —
   * those endpoints answer `500` if actually invoked without one (see
   * `tasks/task-evidences-routes.ts`), rather than throwing an unhandled
   * exception.
   */
  evidenceStore?: EvidenceStore;
  /**
   * 催促の予約を計画し直す契機（機能仕様 docs/features/scheduled-nudges.md
   * 「S2 の設計」: 状態を変える API 要求〔`/api` の GET 以外〕の後）。
   * 指定すると、`/api` の GET・HEAD・OPTIONS 以外の要求の応答の後に呼ぶ
   * （応答を待たせない・例外を応答へ漏らさない）。SSE の応答は、ルートが
   * 預けたストリームの後始末（`deferStateChangeNotice`）が終わったときに
   * もう 1 回呼ぶ。開発者用の版（`app.ts`）は渡さない——毎分方式の
   * まま（決定 5）。製品版の器（S3）が計画し直しの入口
   * （`createNudgeReplanner` の `requestReplan`）を渡す。
   */
  onStateChangingRequest?: () => void;
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
 * Claude client resolution — sessions (chat and session summary),
 * dashboard (boss comment) and reports (evening summary) — receives it
 * explicitly and hands it to the selection resolver (`llm/llm-selection.ts`).
 */
export function createCoreApp(
  db: DbPort,
  env: AppEnv,
  options: CreateCoreAppOptions = {},
): Hono {
  const api = new Hono();
  const onStateChangingRequest = options.onStateChangingRequest;
  if (onStateChangingRequest) {
    api.use("*", async (c, next) => {
      await next();
      if (READ_ONLY_METHODS.has(c.req.method)) return;
      const notify = (): void => {
        try {
          onStateChangingRequest();
        } catch (err) {
          console.error(
            "state-changing request hook failed:",
            err instanceof Error ? (err.stack ?? err.message) : err,
          );
        }
      };
      notify();
      // SSE（チャット）はボスのツールによる状態の変更が応答を返した後の
      // ストリームの中で起きるため、ルートが預けた後始末（利用者が生成を
      // 止めたときの中断メッセージの保存・実行中のツールの完了を含む）が
      // 終わったときにもう 1 回呼ぶ（state-change-notice.ts）。
      const deferred = takeDeferredStateChange(c.req.raw);
      if (deferred) {
        void deferred.then(notify, notify);
      }
    });
  }

  api.get("/health", async (c) => {
    return c.json({ status: "ok", db: await checkDatabaseConnection(db) });
  });

  api.route("/tasks", createTasksRouter(db, options.evidenceStore));
  api.route("/sessions", createSessionsRouter(db, env));
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
