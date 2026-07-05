import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createTasksRouter } from "./tasks/tasks-routes.js";
import { createSessionsRouter } from "./sessions/sessions-routes.js";
import { createActivityRouter } from "./activity/activity-routes.js";
import { createCheckinsRouter } from "./activity/checkins-routes.js";

function checkDatabaseConnection(db: Database.Database): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the Hono application. Routes are namespaced under `/api`.
 *
 * `env` defaults to `process.env` and is only consulted by the chat message
 * route (Claude API key resolution); it is threaded through explicitly so
 * tests can inject a fake environment without mutating global state.
 */
export function createApp(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): Hono {
  const api = new Hono();

  api.get("/health", (c) => {
    return c.json({ status: "ok", db: checkDatabaseConnection(db) });
  });

  api.route("/tasks", createTasksRouter(db));
  api.route("/sessions", createSessionsRouter(db, env));
  api.route("/checkins", createCheckinsRouter(db));
  api.route("/activity", createActivityRouter(db));

  const app = new Hono();
  app.route("/api", api);

  return app;
}
