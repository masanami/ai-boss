// 作業ログ生成の「収集」段（収集 → レンダリングの2段構成のうち1段目。
// docs/adr/0006-renderer-owns-structure.md）。decisions / activity_events / tasks を
// 読み取り専用で参照する。日報の収集段（collect-daily-report-data.ts）と異なり
// 夕会セッションに依存せず、対象ローカル暦日だけを入力に取る（作業ログは
// 「いつでも生成可」— docs/adr/0008-evening-dialogue-prerequisite.md 帰結）。
import type Database from "better-sqlite3";
import type { DecisionStatus } from "../decisions/decision.js";
// 集計範囲の境界は activity/local-day.ts へ集約する（ADR 0007 帰結。収集段ごとに
// 自前の境界計算を持たない）。dashboard/today-escalation.ts に 4 個目の重複が
// 残っており、その取り込みは #236。
import { startOfLocalDayIso, startOfNextLocalDayIso } from "../activity/local-day.js";

/**
 * 作業ログに載せる activity_events の種別（`chat_message` を除く6種）。
 * 「1メッセージごとに記録される機械イベントでノイズになる」ため
 * `chat_message` は収集段で既に除外する。`task_pause` は一時停止の事実を
 * 時系列に残すため対象に含める（#179）。
 */
export const WORK_LOG_ACTIVITY_EVENT_TYPES = [
  "task_start",
  "task_update",
  "break_start",
  "break_end",
  "checkin",
  "task_pause",
] as const;
export type WorkLogActivityEventType = (typeof WORK_LOG_ACTIVITY_EVENT_TYPES)[number];

export interface CollectedWorkLogDecision {
  id: number;
  status: DecisionStatus;
  /** rationale は作業ログに含めない仕様のため収集しない */
  content: string;
  createdAt: Date;
}

export interface CollectedWorkLogActivityEvent {
  id: number;
  type: WorkLogActivityEventType;
  /**
   * `tasks.title` を解決済みの値。`task_id` が null、または参照先タスクが
   * 存在しない（削除済み等）場合はいずれも null
   * （レンダラー側で共通ラベル「（タスク未指定）」に変換する）。
   */
  taskTitle: string | null;
  note: string | null;
  expectedMinutes: number | null;
  createdAt: Date;
}

export interface CollectedWorkLogData {
  /** 対象ローカル暦日（呼び出し側が渡した日付をそのまま保持する） */
  targetDate: Date;
  decisions: CollectedWorkLogDecision[];
  activityEvents: CollectedWorkLogActivityEvent[];
}

interface DecisionRow {
  id: number;
  status: DecisionStatus;
  content: string;
  created_at: string;
}

interface ActivityEventRow {
  id: number;
  type: WorkLogActivityEventType;
  note: string | null;
  expected_minutes: number | null;
  created_at: string;
  task_title: string | null;
}

/**
 * 対象ローカル暦日（半開区間 `[対象ローカル暦日 00:00, 翌ローカル暦日 00:00)`）の
 * 決定ログ全件（`active`/`revised`/`withdrawn`）と、対象6種の activity_events を
 * 読み取る。夕会 `ended_at` による範囲拡張は行わない
 * （作業ログは夕会に依存しない事実列挙。暦日の基準は
 * docs/adr/0007-local-calendar-day-basis.md）。
 */
export function collectWorkLogData(db: Database.Database, targetDate: Date): CollectedWorkLogData {
  const dayStartIso = startOfLocalDayIso(targetDate);
  const nextDayStartIso = startOfNextLocalDayIso(targetDate);

  const decisionRows = db
    .prepare(
      `SELECT id, status, content, created_at FROM decisions
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(dayStartIso, nextDayStartIso) as DecisionRow[];

  const decisions: CollectedWorkLogDecision[] = decisionRows.map((row) => ({
    id: row.id,
    status: row.status,
    content: row.content,
    createdAt: new Date(row.created_at),
  }));

  const typePlaceholders = WORK_LOG_ACTIVITY_EVENT_TYPES.map(() => "?").join(", ");
  const eventRows = db
    .prepare(
      `SELECT e.id AS id, e.type AS type, e.note AS note,
              e.expected_minutes AS expected_minutes, e.created_at AS created_at,
              t.title AS task_title
       FROM activity_events e
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.type IN (${typePlaceholders}) AND e.created_at >= ? AND e.created_at < ?
       ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(...WORK_LOG_ACTIVITY_EVENT_TYPES, dayStartIso, nextDayStartIso) as ActivityEventRow[];

  const activityEvents: CollectedWorkLogActivityEvent[] = eventRows.map((row) => ({
    id: row.id,
    type: row.type,
    taskTitle: row.task_title,
    note: row.note,
    expectedMinutes: row.expected_minutes,
    createdAt: new Date(row.created_at),
  }));

  return { targetDate, decisions, activityEvents };
}
