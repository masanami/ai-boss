import cron from "node-cron";
import type Database from "better-sqlite3";
import { createTicker, type TickDeps } from "./scheduler-tick.js";
import { nodeSystemExecFile } from "../notifications/notifier.js";

/** Every minute — Issue #7's critical design decision ("スケジューラは毎分
 * チェック方式"), reaffirmed by Issue #38's explicit assumptions. */
const CRON_EXPRESSION = "* * * * *";

export interface SchedulerDeps {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  notificationUrl?: string;
}

export interface SchedulerHandle {
  /** Stops the cron job. Safe to call once at process shutdown (graceful
   * stop — SIGINT/SIGTERM, wired in index.ts). */
  stop(): void;
}

/**
 * Starts the node-cron job that drives the slacking-detection tick every
 * minute. The tick function itself (fire -> generate body -> send -> record,
 * plus the concurrency guard) lives in scheduler-tick.ts and is tested
 * directly, independently of node-cron — this module is a thin wrapper
 * only, in the same spirit as notifier.ts's `nodeSystemExecFile` (untested
 * here; see that module's convention).
 */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  const tickDeps: TickDeps = {
    db: deps.db,
    env: deps.env,
    execFile: nodeSystemExecFile,
    notificationUrl: deps.notificationUrl,
  };
  const ticker = createTicker(tickDeps);

  const task = cron.schedule(CRON_EXPRESSION, () => {
    void ticker.tick();
  });

  return {
    stop(): void {
      task.stop();
    },
  };
}
