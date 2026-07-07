import type Database from "better-sqlite3";
import { listNotificationsSince } from "../notifications/notifications-repository.js";

/** ローカル日付の 0:00 を返す（`listNotificationsSince` の `sinceIso` に渡す）。 */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

/**
 * 今日（ローカル日付）に送信された通知の中で最大の escalation_level を返す。
 * 該当する通知が無い場合は 0（Issue #58 明示的な仮定）。
 */
export function calculateTodayMaxEscalationLevel(
  db: Database.Database,
  now: Date,
): number {
  const sinceIso = startOfLocalDay(now).toISOString();
  const notifications = listNotificationsSince(db, sinceIso);

  return notifications.reduce(
    (max, notification) => Math.max(max, notification.escalation_level ?? 0),
    0,
  );
}
