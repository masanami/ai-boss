import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createTasksRouter } from "./tasks/tasks-routes.js";
import { createSessionsRouter } from "./sessions/sessions-routes.js";

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
 */
export function createApp(db: Database.Database): Hono {
  const api = new Hono();

  api.get("/health", (c) => {
    return c.json({ status: "ok", db: checkDatabaseConnection(db) });
  });

  api.route("/tasks", createTasksRouter(db));
  api.route("/sessions", createSessionsRouter(db));

  const app = new Hono();
  app.route("/api", api);

  return app;
}
