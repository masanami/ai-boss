import type { ActivityEvent } from "../activity/activity-event.js";
import type {
  EscalationIntervalSettings,
  NotificationHistoryEntry,
} from "./detection-types.js";
import { diffInMinutes, latestByTimestamp } from "./time-utils.js";

const MAX_ESCALATION_LEVEL = 3;

export interface EscalationResult {
  escalationLevel: number;
}

function intervalForLevel(
  currentLevel: number,
  settings: EscalationIntervalSettings,
): number {
  if (currentLevel <= 1) return settings.level1ToLevel2Minutes;
  if (currentLevel === 2) return settings.level2ToLevel3Minutes;
  return settings.level3RepeatMinutes;
}

function latestEntryFor(
  ruleKey: string,
  notifications: NotificationHistoryEntry[],
): NotificationHistoryEntry | undefined {
  const matching = notifications.filter((entry) => entry.ruleKey === ruleKey);
  return latestByTimestamp(matching, (entry) => entry.sentAt);
}

function hasActivitySince(
  sentAt: string,
  activityEvents: ActivityEvent[],
): boolean {
  const sentAtMs = new Date(sentAt).getTime();
  return activityEvents.some(
    (event) => new Date(event.created_at).getTime() > sentAtMs,
  );
}

/**
 * rule_key ごとの通知履歴・活動シグナルから、今回発火すべきか／どのレベルで発火
 * すべきかを決定する。ルール自体の発火条件（未着手が閾値超過等）が現在も
 * 成立していることは呼び出し側が保証してから呼ぶこと。
 *
 * - 履歴が無ければ L1 で即発火（初回）
 * - 前回通知より後に活動シグナルがあれば L1 にリセットして即発火
 * - それ以外は「前回のレベル別間隔」が経過していれば次のレベルへ（L3 で頭打ち）
 * - 間隔未経過なら null（今回は発火しない = 重複送信防止）
 */
export function resolveEscalation(
  ruleKey: string,
  now: Date,
  notifications: NotificationHistoryEntry[],
  activityEvents: ActivityEvent[],
  settings: EscalationIntervalSettings,
): EscalationResult | null {
  const last = latestEntryFor(ruleKey, notifications);

  if (!last) {
    return { escalationLevel: 1 };
  }

  if (hasActivitySince(last.sentAt, activityEvents)) {
    return { escalationLevel: 1 };
  }

  const elapsed = diffInMinutes(now, new Date(last.sentAt));
  const interval = intervalForLevel(last.escalationLevel, settings);
  if (elapsed < interval) {
    return null;
  }

  const nextLevel = Math.min(last.escalationLevel + 1, MAX_ESCALATION_LEVEL);
  return { escalationLevel: nextLevel };
}
