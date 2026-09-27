import { DEFAULT_DETECTION_SETTINGS } from "../detection/detection-types.js";
import { toDateKey } from "../detection/time-utils.js";
import type { DailyDetectionValues } from "./plan-nudges.js";

/**
 * `plan-nudges.test.ts` と `compact-plan-history.test.ts` が共通で使う
 * テスト補助（`detection/detection-test-fixtures.ts` と同じ置き方）。
 * `dailyValues` から渡す 2 フィールドを除いた検知設定（`PlanNudgesInput.settings`
 * の形）。
 */
const { morningMeetingTime: _unusedMorning, eveningMeetingTime: _unusedEvening, ...PLAN_SETTINGS_REST } =
  DEFAULT_DETECTION_SETTINGS;
void _unusedMorning;
void _unusedEvening;
export const PLAN_SETTINGS = PLAN_SETTINGS_REST;

export const DEFAULT_DAILY: DailyDetectionValues = {
  morningMeetingTime: DEFAULT_DETECTION_SETTINGS.morningMeetingTime,
  eveningMeetingTime: DEFAULT_DETECTION_SETTINGS.eveningMeetingTime,
  // 既定では朝会・夕会を対象外にして、他のルールのテストにノイズが混ざらないようにする
  sessionTypes: ["morning", "evening"],
};

/** [from, to) の間に含まれるローカル暦日キーを昇順・重複無しで返す（テスト用の素朴な実装） */
export function dateKeysInRange(from: Date, toExclusive: Date): string[] {
  const keys: string[] = [];
  let cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const lastInstant = new Date(toExclusive.getTime() - 1);
  const endCursor = new Date(lastInstant.getFullYear(), lastInstant.getMonth(), lastInstant.getDate());
  while (cursor.getTime() <= endCursor.getTime()) {
    keys.push(toDateKey(cursor));
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return keys;
}

/** from〜to（排他）の全暦日に同じ値を割り当てた dailyValues を作る */
export function uniformDailyValues(
  from: Date,
  toExclusive: Date,
  value: Partial<DailyDetectionValues> = {},
): Map<string, DailyDetectionValues> {
  const map = new Map<string, DailyDetectionValues>();
  for (const key of dateKeysInRange(from, toExclusive)) {
    map.set(key, { ...DEFAULT_DAILY, ...value });
  }
  return map;
}
