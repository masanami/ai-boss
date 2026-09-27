import type { Db } from "../db/db-port.js";
import type { DailyReport, DailyReportSummary } from "./daily-report.js";

export interface UpsertDailyReportRecord {
  date: string;
  content: string;
  evening_session_id: number;
}

/**
 * Finds the daily report for a given local date key (`YYYY-MM-DD`), or
 * `undefined` if none exists yet.
 */
export async function findDailyReportByDate(
  db: Db,
  date: string,
): Promise<DailyReport | undefined> {
  return db.get<DailyReport>("SELECT * FROM daily_reports WHERE date = ?", [date]);
}

/**
 * Upserts a daily report for `record.date` (the `date` column is UNIQUE —
 * see migration v3). Re-generation (same date) overwrites `content` and
 * `evening_session_id` and refreshes `updated_at`, but keeps the original
 * `created_at` (excluded from the `ON CONFLICT` update set), matching
 * docs/adr/0005-sqlite-schema-policy.md 検討した代替案（1日1行・再生成は
 * 同日行の UPSERT・世代管理はしない）.
 */
export async function upsertDailyReport(
  db: Db,
  record: UpsertDailyReportRecord,
): Promise<DailyReport> {
  const now = new Date().toISOString();

  // UPSERT と読み戻しを 1 つのトランザクションで行う（#606 self-review）:
  // 別々だと、同じ日付の並行する生成の UPSERT が間に入り、相手の行を読み戻して
  // 返しうる。
  return db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         content = excluded.content,
         evening_session_id = excluded.evening_session_id,
         updated_at = excluded.updated_at`,
      [record.date, record.content, record.evening_session_id, now, now],
    );

    const report = await findDailyReportByDate(tx, record.date);
    if (!report) {
      throw new Error("failed to read back the upserted daily report");
    }
    return report;
  });
}

/**
 * Returns all daily reports ordered by `date` descending, for the report
 * list screen (`GET /api/reports`). Only `date`/`created_at`/`updated_at`
 * are returned — `content` is intentionally excluded.
 */
export async function listDailyReports(db: Db): Promise<DailyReportSummary[]> {
  return db.all<DailyReportSummary>(
    "SELECT date, created_at, updated_at FROM daily_reports ORDER BY date DESC",
  );
}
