import type Database from "better-sqlite3";
import type { Notification } from "./notification.js";

export interface NewNotificationRecord {
  type: string;
  rule_key?: string | null;
  escalation_level?: number | null;
  body: string;
}

/**
 * Records a sent notification into `notifications`. `sent_at` is
 * server-managed (current time). This is the single source of truth the
 * (future) detection engine/scheduler uses to avoid duplicate sends and to
 * track escalation state per `rule_key`.
 */
export function insertNotification(
  db: Database.Database,
  record: NewNotificationRecord,
): Notification {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      record.type,
      record.rule_key ?? null,
      record.escalation_level ?? null,
      record.body,
      now,
    );

  const notification = db
    .prepare("SELECT * FROM notifications WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Notification | undefined;
  if (!notification) {
    throw new Error("failed to read back the inserted notification");
  }
  return notification;
}

/**
 * Returns the most recently sent notification for `ruleKey`, or `undefined`
 * when none has been sent yet. Used to resolve the current escalation level
 * for a rule (未実装の検知エンジンが利用する想定).
 */
export function findLatestNotificationByRuleKey(
  db: Database.Database,
  ruleKey: string,
): Notification | undefined {
  return db
    .prepare(
      "SELECT * FROM notifications WHERE rule_key = ? ORDER BY sent_at DESC, id DESC LIMIT 1",
    )
    .get(ruleKey) as Notification | undefined;
}

/**
 * Returns notifications sent at or after `sinceIso`, oldest first. Intended
 * as the notification-history input for the (future) detection engine
 * (e.g. "直近 N 時間分" queries — the caller computes `sinceIso`).
 */
export function listNotificationsSince(
  db: Database.Database,
  sinceIso: string,
): Notification[] {
  return db
    .prepare(
      "SELECT * FROM notifications WHERE sent_at >= ? ORDER BY sent_at ASC, id ASC",
    )
    .all(sinceIso) as Notification[];
}
