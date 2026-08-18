import { Hono } from "hono";
import type Database from "better-sqlite3";
import { toDateKey } from "../detection/time-utils.js";
import { collectWorkLogData } from "./collect-work-log-data.js";
import { renderWorkLog } from "./render-work-log.js";

const DATE_PARAM_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `:date`（`YYYY-MM-DD`）をローカル日付として解釈する。形式不正、または
 * 実在しない暦日（例: 2026-02-30 は3月2日へ繰り上がる）は null を返す。
 * `toDateKey` で往復させて繰り上がりを検知することで、月ごとの日数上限を
 * 手書きしない（docs/features/work-log.md「エラー形式」の `invalid_date`）。
 */
function parseDateParam(dateParam: string): Date | null {
  const match = DATE_PARAM_PATTERN.exec(dateParam);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr] = match;
  const date = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr), 0, 0, 0, 0);
  if (toDateKey(date) !== dateParam) return null;

  return date;
}

/**
 * 作業ログルーター（`server/app.ts` が `/api/work-logs` にマウントする）。
 * `/api/reports/:date` とのパス衝突を避けるため独立ルーターとする
 * （docs/features/work-log.md「機能全体の設計 > アーキテクチャ決定」）。
 * 生成条件は無く（前提条件なし・保存なし・オンデマンド算出）、常に読み取り
 * 専用の収集 → レンダリングの2段で完結する。
 */
export function createWorkLogsRouter(db: Database.Database): Hono {
  const workLogs = new Hono();

  workLogs.get("/:date", (c) => {
    const dateParam = c.req.param("date");
    const date = parseDateParam(dateParam);
    if (!date) {
      return c.json({ error: `invalid date: ${dateParam}`, code: "invalid_date" }, 400);
    }

    const collected = collectWorkLogData(db, date);
    const content = renderWorkLog({
      date: collected.targetDate,
      decisions: collected.decisions,
      activityEvents: collected.activityEvents,
    });

    return c.json({ date: dateParam, content }, 200);
  });

  return workLogs;
}
