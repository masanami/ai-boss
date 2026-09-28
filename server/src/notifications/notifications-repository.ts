import type { Db } from "../db/db-port.js";
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
export async function insertNotification(
  db: Db,
  record: NewNotificationRecord,
): Promise<Notification> {
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    [
      record.type,
      record.rule_key ?? null,
      record.escalation_level ?? null,
      record.body,
      now,
    ],
  );

  const notification = await db.get<Notification>(
    "SELECT * FROM notifications WHERE id = ?",
    [result.lastInsertRowid],
  );
  if (!notification) {
    throw new Error("failed to read back the inserted notification");
  }
  return notification;
}

/**
 * `channel` の値: OS の予約通知として登録し、予約時刻を過ぎたことで確定した
 * 行（機能仕様 docs/features/scheduled-nudges.md 決定 2）。OS が表示したかは
 * アプリから分からないため `delivered` は NULL（不明）のまま。
 */
export const SCHEDULED_NOTIFICATION_CHANNEL = "scheduled";

export interface ScheduledNotificationRecord extends NewNotificationRecord {
  /** 予約時刻（ISO8601）。`sent_at` にそのまま書く */
  sent_at: string;
}

/**
 * 予約通知方式で予約時刻を過ぎた予約を、送信履歴として確定する（決定 2）。
 * `sent_at` は予約時刻、`delivered` は NULL（不明）、`channel` は
 * {@link SCHEDULED_NOTIFICATION_CHANNEL}。
 */
export async function insertScheduledNotification(
  db: Db,
  record: ScheduledNotificationRecord,
): Promise<void> {
  await db.run(
    `INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at, delivered, channel)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    [
      record.type,
      record.rule_key ?? null,
      record.escalation_level ?? null,
      record.body,
      record.sent_at,
      SCHEDULED_NOTIFICATION_CHANNEL,
    ],
  );
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
export async function recordNotificationDelivery(
  db: Db,
  id: number,
  result: NotificationDeliveryRecord,
): Promise<void> {
  const { changes } = await db.run(
    "UPDATE notifications SET delivered = ?, channel = ? WHERE id = ?",
    [result.delivered ? 1 : 0, result.channel, id],
  );
  if (changes === 0) {
    throw new Error(`notification ${id} not found; delivery outcome was not recorded`);
  }
}

/**
 * Returns the most recently sent notification for `ruleKey`, or `undefined`
 * when none has been sent yet. Used to resolve the current escalation level
 * for a rule (未実装の検知エンジンが利用する想定).
 */
export async function findLatestNotificationByRuleKey(
  db: Db,
  ruleKey: string,
): Promise<Notification | undefined> {
  return db.get<Notification>(
    "SELECT * FROM notifications WHERE rule_key = ? ORDER BY sent_at DESC, id DESC LIMIT 1",
    [ruleKey],
  );
}

/**
 * Returns notifications sent at or after `sinceIso`, oldest first. Intended
 * as the notification-history input for the (future) detection engine
 * (e.g. "直近 N 時間分" queries — the caller computes `sinceIso`).
 */
export async function listNotificationsSince(
  db: Db,
  sinceIso: string,
): Promise<Notification[]> {
  return db.all<Notification>(
    "SELECT * FROM notifications WHERE sent_at >= ? ORDER BY sent_at ASC, id ASC",
    [sinceIso],
  );
}

/**
 * Returns notifications with `sinceIso <= sent_at < untilIsoExclusive`,
 * oldest first — the half-open window of ADR 0007 決定3. Used by the
 * dashboard's today-escalation aggregate (#236) so the query itself bounds
 * "today" instead of relying on no future-dated row ever existing (a clock
 * rollback leaves such rows behind, since `sent_at` is the server's absolute
 * time). Kept as a separate function rather than an optional argument on
 * `listNotificationsSince` so that function's unbounded contract for the
 * detection engine's history read-back stays visibly unchanged (#236).
 */
export async function listNotificationsBetween(
  db: Db,
  sinceIso: string,
  untilIsoExclusive: string,
): Promise<Notification[]> {
  return db.all<Notification>(
    "SELECT * FROM notifications WHERE sent_at >= ? AND sent_at < ? ORDER BY sent_at ASC, id ASC",
    [sinceIso, untilIsoExclusive],
  );
}
