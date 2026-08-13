import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { startScheduler } from "./scheduler/scheduler.js";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
runMigrations(db);

// Resolved relative to this module (not cwd) so it works both compiled
// (server/dist/index.js) and under tsx watch (server/src/index.ts).
const webDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticRoot = existsSync(webDistPath) ? webDistPath : undefined;

if (!staticRoot) {
  console.warn(
    `web のビルド成果物が見つかりません（${webDistPath}）。API のみ起動します。` +
      "フロントエンドも配信するには `npm run build` を実行してください（`npm run start` は自動でビルドします）。",
  );
}

const app = createApp(db, process.env, { staticRoot, llmBackend: config.llmBackend });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ai-boss server listening on port ${info.port}`);
  if (staticRoot) {
    console.log(`web assets served from ${staticRoot}`);
  }
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
