import { Hono } from "hono";
import type { Db } from "../db/db-port.js";
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
  db: Db,
  env: NodeJS.ProcessEnv,
): Hono {
  const dashboard = new Hono();

  dashboard.get("/", async (c) => {
    const now = new Date();
    // 進捗・会の実施・当日の最大エスカレーションは 1 つのトランザクションで
    // 読む（#606・決定 2 の全数監査: 並行する書き込みの途中の組み合わせを表示
    // しない）。ボスのひとことは LLM を呼びうるのでトランザクションの外で得る。
    const snapshot = await db.transaction(async (tx) => ({
      todaysSessionTypes: await listTodaysSessionTypes(tx, now),
      tasks: await listTasks(tx),
      todayMaxEscalationLevel: await calculateTodayMaxEscalationLevel(tx, now),
    }));

    const response: DashboardResponse = {
      progress: calculateProgress(snapshot.tasks, now),
      morningSessionHeld: snapshot.todaysSessionTypes.includes("morning"),
      eveningSessionHeld: snapshot.todaysSessionTypes.includes("evening"),
      todayMaxEscalationLevel: snapshot.todayMaxEscalationLevel,
      bossComment: await getOrGenerateBossComment(db, env, now),
      date: toDateKey(now),
    };

    return c.json(response);
  });

  return dashboard;
}
