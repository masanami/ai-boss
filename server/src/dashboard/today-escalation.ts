import type Database from "better-sqlite3";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "../activity/local-day.js";
import { listNotificationsBetween } from "../notifications/notifications-repository.js";

/**
 * 今日（ローカル日付）に送信された通知の中で最大の escalation_level を返す。
 * 該当する通知が無い場合は 0（Issue #58 明示的な仮定）。
 *
 * 「今日」は半開区間 `[当日ローカル 00:00, 翌ローカル暦日 00:00)`（ADR 0007
 * 決定3）。上限を置くのは、時計を戻したときに残る未来日時の行（`sent_at` は
 * サーバー時刻の UTC 絶対値。手動投入・インポートでも生じうる）が当日いっぱい
 * 集計を膨らませないため（#236。`GET /api/activity/today` の #230 と同じ欠陥
 * クラス）。両境界は同じ `now` から導出する（activity-routes.ts と同じ理由）。
 */
export function calculateTodayMaxEscalationLevel(
  db: Database.Database,
  now: Date,
): number {
  const notifications = listNotificationsBetween(
    db,
    startOfLocalDayIso(now),
    startOfNextLocalDayIso(now),
  );

  return notifications.reduce(
    (max, notification) => Math.max(max, notification.escalation_level ?? 0),
    0,
  );
}
