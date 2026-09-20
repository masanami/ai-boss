import type Database from "better-sqlite3";
import type { MeetingType, MeetingTimeOverrides } from "./meeting-schedule.js";

interface MeetingTimeOverrideRow {
  meeting_type: MeetingType;
  meeting_time: string;
}

/**
 * その日に保存されている上書きを、種別ごとに `{ morning?, evening? }` の形
 * で返す。行が無い種別はキーを持たない（`meeting-schedule.ts` の
 * `MeetingTimeOverrides` 契約どおり）。
 */
export function findOverridesByDate(
  db: Database.Database,
  date: string,
): MeetingTimeOverrides {
  const rows = db
    .prepare(
      "SELECT meeting_type, meeting_time FROM meeting_time_overrides WHERE date = ?",
    )
    .all(date) as MeetingTimeOverrideRow[];

  const overrides: MeetingTimeOverrides = {};
  for (const row of rows) {
    overrides[row.meeting_type] = row.meeting_time;
  }
  return overrides;
}

/**
 * 指定の日・種別の上書きを保存する（`UNIQUE (date, meeting_type)` により
 * 既存行があれば更新、無ければ新規挿入）。`created_at` は初回挿入時のみ、
 * `updated_at` は常に現在時刻で更新する
 * （`tasks-repository.ts` / `daily-reports-repository.ts` と同じ既存の作法。
 * 呼び出し元から `now` を渡す形にしない）。
 *
 * 時刻の書式検証・遅延上限の検証はこの関数の責務ではない（API 層
 * `meeting-schedule-routes.ts` が担う）。
 */
export function upsertOverride(
  db: Database.Database,
  date: string,
  type: MeetingType,
  time: string,
): void {
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO meeting_time_overrides (date, meeting_type, meeting_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date, meeting_type) DO UPDATE SET
       meeting_time = excluded.meeting_time,
       updated_at = excluded.updated_at`,
  ).run(date, type, time, now, now);
}

/** 指定の日・種別の上書きを削除する。行が無い場合は no-op。 */
export function deleteOverride(
  db: Database.Database,
  date: string,
  type: MeetingType,
): void {
  db.prepare(
    "DELETE FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
  ).run(date, type);
}
