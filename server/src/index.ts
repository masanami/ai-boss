import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
runMigrations(db);

const app = createApp(db);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ai-boss server listening on port ${info.port}`);
});
