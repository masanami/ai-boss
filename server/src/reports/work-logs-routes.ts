import { Hono } from "hono";
import type { Db } from "../db/db-port.js";
import { parseDateKey } from "../detection/time-utils.js";
import { collectWorkLogData } from "./collect-work-log-data.js";
import { renderWorkLog } from "./render-work-log.js";

/**
 * 作業ログルーター（`server/app.ts` が `/api/work-logs` にマウントする）。
 * `/api/reports/:date` とのパス衝突を避けるため独立ルーターとする。
 * 生成条件は無く（前提条件なし・保存なし・オンデマンド算出。
 * docs/adr/0005-sqlite-schema-policy.md 決定 6・
 * docs/adr/0008-evening-dialogue-prerequisite.md 帰結）、常に読み取り
 * 専用の収集 → レンダリングの2段で完結する。
 */
export function createWorkLogsRouter(db: Db): Hono {
  const workLogs = new Hono();

  workLogs.get("/:date", async (c) => {
    const dateParam = c.req.param("date");
    const date = parseDateKey(dateParam);
    if (!date) {
      return c.json({ error: `invalid date: ${dateParam}`, code: "invalid_date" }, 400);
    }

    const collected = await collectWorkLogData(db, date);
    const content = renderWorkLog({
      date: collected.targetDate,
      decisions: collected.decisions,
      activityEvents: collected.activityEvents,
    });

    return c.json({ date: dateParam, content }, 200);
  });

  return workLogs;
}
