import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listTasks } from "../tasks/tasks-repository.js";
import { listTodaysSessionTypes } from "../scheduler/todays-sessions.js";
import { toDateKey } from "../detection/time-utils.js";
import { calculateProgress } from "./progress.js";
import { calculateTodayMaxEscalationLevel } from "./today-escalation.js";
import { getOrGenerateBossComment } from "./boss-comment.js";
import type { DashboardResponse } from "./dashboard.js";

/**
 * Creates the dashboard sub-router, mounted under `/api/dashboard` by the
 * caller. `env` is threaded through to the boss-comment generator (Claude
 * API key resolution), mirroring `createSessionsRouter`'s pattern.
 */
export function createDashboardRouter(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): Hono {
  const dashboard = new Hono();

  dashboard.get("/", async (c) => {
    const now = new Date();
    const todaysSessionTypes = listTodaysSessionTypes(db, now);

    const response: DashboardResponse = {
      progress: calculateProgress(listTasks(db), now),
      morningSessionHeld: todaysSessionTypes.includes("morning"),
      eveningSessionHeld: todaysSessionTypes.includes("evening"),
      todayMaxEscalationLevel: calculateTodayMaxEscalationLevel(db, now),
      bossComment: await getOrGenerateBossComment(db, env, now),
      date: toDateKey(now),
    };

    return c.json(response);
  });

  return dashboard;
}
