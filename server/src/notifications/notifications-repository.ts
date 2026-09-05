import type Database from "better-sqlite3";
import type { Notification } from "./notification.js";

export interface NewNotificationRecord {
  type: string;
  rule_key?: string | null;
  escalation_level?: number | null;
  body: string;
}

/**
 * Delivery outcome to write back onto a recorded notification (#321). Shaped
 * so the notifier's `SendNotificationResult` is directly assignable, without
 * this module depending on the notifier: `channel` is stored verbatim (the
 * notifier's own vocabulary, no re-mapping — see `Notification.channel`).
 */
export interface NotificationDeliveryRecord {
  delivered: boolean;
  channel: string;
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
 * Writes the delivery outcome of `sendNotification` back onto an already
 * recorded notification (#321). The record itself is inserted *before* the
 * send (Issue #221), so `delivered`/`channel` start out NULL ("unknown") and
 * are filled in here afterwards — this never changes what the insert means.
 *
 * Throws if no row has `id`: a silent no-op here would recreate exactly the
 * kind of unobservable failure this column exists to expose.
 */
export function recordNotificationDelivery(
  db: Database.Database,
  id: number,
  result: NotificationDeliveryRecord,
): void {
  const { changes } = db
    .prepare("UPDATE notifications SET delivered = ?, channel = ? WHERE id = ?")
    .run(result.delivered ? 1 : 0, result.channel, id);
  if (changes === 0) {
    throw new Error(`notification ${id} not found; delivery outcome was not recorded`);
  }
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
