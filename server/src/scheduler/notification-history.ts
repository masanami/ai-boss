import type { Notification } from "../notifications/notification.js";
import type { NotificationHistoryEntry } from "../detection/detection-types.js";

/**
 * Converts `notifications` DB rows (snake_case, nullable `rule_key` /
 * `escalation_level`) into the plain-data shape the (pure) detection rule
 * engine expects. Rows with a null `rule_key` or `escalation_level` cannot
 * be matched by the engine's rule_key-scoped escalation lookup
 * (`detection/escalation.ts`), so they are dropped rather than guessed at.
 */
export function toNotificationHistory(rows: Notification[]): NotificationHistoryEntry[] {
  const result: NotificationHistoryEntry[] = [];
  for (const row of rows) {
    if (row.rule_key === null || row.escalation_level === null) continue;
    result.push({
      ruleKey: row.rule_key,
      escalationLevel: row.escalation_level,
      sentAt: row.sent_at,
    });
  }
  return result;
}
