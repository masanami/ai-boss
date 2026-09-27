// 日報生成の「収集」段（収集 → 値の抽出 → レンダリング → 保存 の4段のうち
// 1段目。docs/adr/0006-renderer-owns-structure.md）。tasks / activity_events / decisions を
// 読み取り専用で参照する。LLM 呼び出し・API ルート・夕会終了フックはここでは
// 扱わない（依存チケット #107-#110 の範囲）。
import type { Db } from "../db/db-port.js";
import type { Session } from "../sessions/session.js";
import { computeActivityRecord } from "./activity-record.js";
import type { ActivityRecordEvent } from "./activity-record.js";

// 集計範囲の境界は activity/local-day.ts へ集約する（ADR 0007 帰結。収集段ごとに
// 自前の境界計算を持たない）。
import { startOfLocalDayIso, startOfNextLocalDayIso } from "../activity/local-day.js";

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
 * `[00:00:00.000, 翌ローカル暦日 00:00:00.000)`（半開区間。翌日境界は暦日を
 * 1 日進めて求め、固定秒数の加算はしない。ADR 0007 決定3）。休憩イベント
 * （break_start / break_end）の探索のみ、日跨ぎ夕会に対応するため夕会セッションの
 * ended_at まで両方とも同じ窓で拡張し、翌暦日に始まった休憩は対応付け後に
 * 集計から除外する（日報の「活動記録」の休憩回数・合計時間を成立させるための
 * 対応付け規則は activity-record.ts。暦日の基準は
 * docs/adr/0007-local-calendar-day-basis.md）。
 *
 * `eveningSession.ended_at` が null（未終了）の場合は呼び出し側の前提条件違反
 * として例外を投げる（前提条件チェック自体は依頼側チケット #107/#108 の生成
 * サービスが担う）。
 */
export async function collectDailyReportData(
  db: Db,
  eveningSession: Session,
): Promise<CollectedDailyReportData> {
  // 複数の表を読むため、1 つのトランザクションでスナップショットとして読む
  // （#606・決定 2 の全数監査: 並行する書き込みの途中の組み合わせを材料にしない）。
  return db.transaction((tx) => collectDailyReportDataInSnapshot(tx, eveningSession));
}

async function collectDailyReportDataInSnapshot(
  db: Db,
  eveningSession: Session,
): Promise<CollectedDailyReportData> {
  if (eveningSession.ended_at === null) {
    throw new Error(
      "collectDailyReportData requires an ended evening session (ended_at is null)",
    );
  }
  const sessionEndedAtIso = eveningSession.ended_at;

  const targetDate = new Date(eveningSession.started_at);
  const dayStartIso = startOfLocalDayIso(targetDate);
  const nextDayStartIso = startOfNextLocalDayIso(targetDate);
  // 休憩（break_start / break_end）の探索範囲だけ、日跨ぎ夕会に対応するため夕会
  // 終了時刻まで拡張する。**両イベントを同じ窓で取る**（Issue #237: break_start
  // だけ翌暦日 00:00 で切ると、翌暦日に始まった休憩の break_end が対象暦日の
  // 未終了 break_start と誤って結ばれる）。翌暦日に始まった休憩は
  // computeActivityRecord が nextDayStartIso で集計から除外する。
  // 上限は排他（ADR 0007 決定3）で、日跨ぎ夕会のときだけ翌暦日 00:00 より先へ
  // 伸びる。その場合に限り ended_at と完全一致する break_end / break_start は
  // 検索から外れるが、対象暦日の開いている休憩を computeActivityRecord が
  // sessionEndedAt で打ち切る（ended_at ちょうどの break_start は翌暦日の休憩
  // なので元々集計対象外）ため breakCount/breakTotalMinutes は等価になる
  // （activity-record.ts の ActivityRecordInput.breakEnds の doc と対で読むこと）。
  const breakSearchEndIso = sessionEndedAtIso > nextDayStartIso ? sessionEndedAtIso : nextDayStartIso;

  const completedTasks = (
    await db.all<{ title: string }>(
      `SELECT title FROM tasks
         WHERE status = 'done' AND completed_at >= ? AND completed_at < ?
         ORDER BY completed_at ASC, id ASC`,
      [dayStartIso, nextDayStartIso],
    )
  ).map((row) => row.title);

  const inProgressTasks = (
    await db.all<{ title: string }>(
      `SELECT DISTINCT t.title, t.created_at, t.id FROM tasks t
         JOIN activity_events e ON e.task_id = t.id
         WHERE t.status = 'in_progress'
           AND e.type IN ('task_start', 'task_update')
           AND e.created_at >= ? AND e.created_at < ?
         ORDER BY t.created_at ASC, t.id ASC`,
      [dayStartIso, nextDayStartIso],
    )
  ).map((row) => row.title);

  const taskStarts = await db.all<ActivityRecordEvent>(
    `SELECT id, created_at FROM activity_events
       WHERE type = 'task_start' AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    [dayStartIso, nextDayStartIso],
  );

  const breakStarts = await db.all<ActivityRecordEvent>(
    `SELECT id, created_at FROM activity_events
       WHERE type = 'break_start' AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    [dayStartIso, breakSearchEndIso],
  );

  const breakEnds = await db.all<ActivityRecordEvent>(
    `SELECT id, created_at FROM activity_events
       WHERE type = 'break_end' AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
    [dayStartIso, breakSearchEndIso],
  );

  const activityRecord = computeActivityRecord({
    taskStarts,
    breakStarts,
    breakEnds,
    nextDayStartIso,
    sessionEndedAt: sessionEndedAtIso,
  });

  // kind = 'mentoring' 行は除外する（#408 AC-43）。メンタリングの結論は
  // #358 のタスク軸ログ（listDecisions）から参照する記録であり、日報の
  // 「決定事項」として混入させない。
  const decisions = (
    await db.all<{ content: string }>(
      `SELECT content FROM decisions
         WHERE status = 'active' AND kind = 'decision' AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC, id ASC`,
      [dayStartIso, nextDayStartIso],
    )
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
