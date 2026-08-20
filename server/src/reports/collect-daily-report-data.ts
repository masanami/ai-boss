// 日報生成の「収集」段（収集 → 値の抽出 → レンダリング → 保存 の4段のうち
// 1段目。docs/adr/0006-renderer-owns-structure.md）。tasks / activity_events / decisions を
// 読み取り専用で参照する。LLM 呼び出し・API ルート・夕会終了フックはここでは
// 扱わない（依存チケット #107-#110 の範囲）。
import type Database from "better-sqlite3";
import type { Session } from "../sessions/session.js";
import { computeActivityRecord } from "./activity-record.js";
import type { ActivityRecordEvent } from "./activity-record.js";

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export interface CollectedDailyReportData {
  /** 対象ローカル暦日（夕会セッションの started_at のローカル日付） */
  targetDate: Date;
  completedTasks: string[];
  inProgressTasks: string[];
  firstTaskStartAt: Date | null;
  breakCount: number;
  breakTotalMinutes: number;
  decisions: string[];
}

/**
 * 当日のタスク実績・活動記録・決定事項を収集する。
 *
 * 対象ローカル暦日は「夕会セッションの started_at のローカル日付」
 * （`toDateKey` と同じ基準で日付を切り出す。日付キー自体の文字列化はレンダラー
 * 側の責務のためここでは行わない）。タスク・決定の集計範囲はこの暦日の
 * 00:00:00.000〜23:59:59.999。休憩の break_end 探索のみ、日跨ぎ夕会に対応する
 * ため夕会セッションの ended_at まで拡張する
 * （保証 G-170-48「活動記録」の休憩回数・合計時間を成立させるための対応付け
 * 規則。暦日の基準は docs/adr/0007-local-calendar-day-basis.md）。
 *
 * `eveningSession.ended_at` が null（未終了）の場合は呼び出し側の前提条件違反
 * として例外を投げる（前提条件チェック自体は依頼側チケット #107/#108 の生成
 * サービスが担う）。
 */
export function collectDailyReportData(
  db: Database.Database,
  eveningSession: Session,
): CollectedDailyReportData {
  if (eveningSession.ended_at === null) {
    throw new Error(
      "collectDailyReportData requires an ended evening session (ended_at is null)",
    );
  }
  const sessionEndedAtIso = eveningSession.ended_at;

  const targetDate = new Date(eveningSession.started_at);
  const dayStartIso = startOfLocalDay(targetDate).toISOString();
  const dayEndIso = endOfLocalDay(targetDate).toISOString();
  // break_end の探索範囲だけ、日跨ぎ夕会に対応するため夕会終了時刻まで拡張する
  const breakEndSearchEndIso = sessionEndedAtIso > dayEndIso ? sessionEndedAtIso : dayEndIso;

  const completedTasks = (
    db
      .prepare(
        `SELECT title FROM tasks
         WHERE status = 'done' AND completed_at >= ? AND completed_at <= ?
         ORDER BY completed_at ASC, id ASC`,
      )
      .all(dayStartIso, dayEndIso) as { title: string }[]
  ).map((row) => row.title);

  const inProgressTasks = (
    db
      .prepare(
        `SELECT DISTINCT t.title, t.created_at, t.id FROM tasks t
         JOIN activity_events e ON e.task_id = t.id
         WHERE t.status = 'in_progress'
           AND e.type IN ('task_start', 'task_update')
           AND e.created_at >= ? AND e.created_at <= ?
         ORDER BY t.created_at ASC, t.id ASC`,
      )
      .all(dayStartIso, dayEndIso) as { title: string }[]
  ).map((row) => row.title);

  const taskStarts = db
    .prepare(
      `SELECT id, created_at FROM activity_events
       WHERE type = 'task_start' AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(dayStartIso, dayEndIso) as ActivityRecordEvent[];

  const breakStarts = db
    .prepare(
      `SELECT id, created_at FROM activity_events
       WHERE type = 'break_start' AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(dayStartIso, dayEndIso) as ActivityRecordEvent[];

  const breakEnds = db
    .prepare(
      `SELECT id, created_at FROM activity_events
       WHERE type = 'break_end' AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(dayStartIso, breakEndSearchEndIso) as ActivityRecordEvent[];

  const activityRecord = computeActivityRecord({
    taskStarts,
    breakStarts,
    breakEnds,
    sessionEndedAt: sessionEndedAtIso,
  });

  const decisions = (
    db
      .prepare(
        `SELECT content FROM decisions
         WHERE status = 'active' AND created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(dayStartIso, dayEndIso) as { content: string }[]
  ).map((row) => row.content);

  return {
    targetDate,
    completedTasks,
    inProgressTasks,
    firstTaskStartAt: activityRecord.firstTaskStartAt
      ? new Date(activityRecord.firstTaskStartAt)
      : null,
    breakCount: activityRecord.breakCount,
    breakTotalMinutes: activityRecord.breakTotalMinutes,
    decisions,
  };
}
