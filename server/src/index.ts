import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startScheduler } from "./scheduler/scheduler.js";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
runMigrations(db);

const app = createApp(db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ai-boss server listening on port ${info.port}`);
});

// Slacking-detection scheduler (Issue #38): started only from this
// production entry point, never from `createApp`/tests (see
// `scheduler/scheduler.ts` and `scheduler/scheduler-tick.ts`, which are
// tested directly and independently of node-cron/the server process).
const scheduler = startScheduler({ db, env: process.env });

function gracefulStop(signal: NodeJS.Signals): void {
  console.log(`${signal} received, stopping the scheduler...`);
  // Stops future cron triggers only — an in-flight tick is not drained
  // before exiting. Accepted as a local-MVP tradeoff (single-user, no
  // orchestrator to wait for); worst case a signal during a tick loses that
  // tick's notification, which the next minute's tick will naturally retry
  // if the underlying condition still holds.
  scheduler.stop();
  process.exit(0);
}

process.on("SIGINT", gracefulStop);
process.on("SIGTERM", gracefulStop);
