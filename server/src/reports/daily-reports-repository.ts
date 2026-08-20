import type Database from "better-sqlite3";
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
export function findDailyReportByDate(
  db: Database.Database,
  date: string,
): DailyReport | undefined {
  return db.prepare("SELECT * FROM daily_reports WHERE date = ?").get(date) as
    | DailyReport
    | undefined;
}

/**
 * Upserts a daily report for `record.date` (the `date` column is UNIQUE —
 * see migration v3). Re-generation (same date) overwrites `content` and
 * `evening_session_id` and refreshes `updated_at`, but keeps the original
 * `created_at` (excluded from the `ON CONFLICT` update set), matching
 * docs/adr/0005-sqlite-schema-policy.md 検討した代替案（1日1行・再生成は
 * 同日行の UPSERT・世代管理はしない）and 保証 G-170-43 / G-170-80.
 */
export function upsertDailyReport(
  db: Database.Database,
  record: UpsertDailyReportRecord,
): DailyReport {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       content = excluded.content,
       evening_session_id = excluded.evening_session_id,
       updated_at = excluded.updated_at`,
  ).run(record.date, record.content, record.evening_session_id, now, now);

  const report = findDailyReportByDate(db, record.date);
  if (!report) {
    throw new Error("failed to read back the upserted daily report");
  }
  return report;
}

/**
 * Returns all daily reports ordered by `date` descending, for the report
 * list screen (`GET /api/reports`). Only `date`/`created_at`/`updated_at`
 * are returned — `content` is intentionally excluded (保証 G-170-41).
 */
export function listDailyReports(db: Database.Database): DailyReportSummary[] {
  return db
    .prepare("SELECT date, created_at, updated_at FROM daily_reports ORDER BY date DESC")
    .all() as DailyReportSummary[];
}
