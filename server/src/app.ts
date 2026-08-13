import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTasksRouter } from "./tasks/tasks-routes.js";
import { createSessionsRouter } from "./sessions/sessions-routes.js";
import { createActivityRouter } from "./activity/activity-routes.js";
import { createCheckinsRouter } from "./activity/checkins-routes.js";
import { createDecisionsRouter } from "./decisions/decisions-routes.js";
import { createDashboardRouter } from "./dashboard/dashboard-routes.js";
import { createSettingsRouter } from "./settings/settings-routes.js";
import { DEFAULT_LLM_BACKEND, type LlmBackend } from "./config.js";

function checkDatabaseConnection(db: Database.Database): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export interface CreateAppOptions {
  /**
   * Directory of the built web frontend (`web/dist`). When set, its files are
   * served on the same origin as `/api`, with an SPA fallback to `index.html`
   * for unknown non-API paths. When omitted (dev / tests), the app serves the
   * API only and the Vite dev server handles the frontend.
   */
  staticRoot?: string;
  /**
   * LLM backend for the chat (`sessions`) and re-adjudication (`decisions`)
   * routes, resolved by the caller via `loadConfig(env).llmBackend`
   * (`index.ts`) and threaded through to `createClaudeClient`. Defaults to
   * {@link DEFAULT_LLM_BACKEND} for callers that don't pass it (most tests).
   *
   * Dashboard comment / notification-body generation are not wired to this
   * option: those two call sites (`dashboard/boss-comment.ts`,
   * `notifications/notification-body.ts`) still call `createClaudeClient(env)`
   * with no backend argument, so they currently always resolve to
   * `createClaudeClient`'s own `"api"` default regardless of `LLM_BACKEND`.
   * Issue #81 only covers their type annotations (no logic change, per its
   * explicit scope); wiring their backend selection is unassigned follow-up
   * work, not #81's.
   */
  llmBackend?: LlmBackend;
}

/**
 * Creates the Hono application. Routes are namespaced under `/api`.
 *
 * `env` defaults to `process.env` and is threaded through explicitly (so
 * tests can inject a fake environment without mutating global state) to
 * every router that needs Claude client resolution: sessions (chat),
 * decisions (re-adjudication), and dashboard (boss comment).
 */
export function createApp(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
  options: CreateAppOptions = {},
): Hono {
  const api = new Hono();
  const llmBackend: LlmBackend = options.llmBackend ?? DEFAULT_LLM_BACKEND;

  api.get("/health", (c) => {
    return c.json({ status: "ok", db: checkDatabaseConnection(db) });
  });

  api.route("/tasks", createTasksRouter(db));
  api.route("/sessions", createSessionsRouter(db, env, llmBackend));
  api.route("/checkins", createCheckinsRouter(db));
  api.route("/activity", createActivityRouter(db));
  api.route("/decisions", createDecisionsRouter(db, env, llmBackend));
  api.route("/dashboard", createDashboardRouter(db, env));
  api.route("/settings", createSettingsRouter(db));

  const app = new Hono();
  app.route("/api", api);

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
