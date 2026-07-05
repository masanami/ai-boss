import type { WorkingHours } from "./detection-types.js";

/** 値を [min, max] の範囲に収める */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** later - earlier の経過時間を分単位で返す */
export function diffInMinutes(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / (60 * 1000);
}

/** "HH:mm" 形式の文字列を、真夜中からの経過分に変換する */
export function timeStringToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * 現在時刻（ローカル）が勤務時間帯 [start, end) に含まれるか。
 * end は排他的境界（例: end="18:00" なら 18:00 ちょうどは対象外）。
 */
export function isWithinWorkingHours(
  now: Date,
  workingHours: WorkingHours,
): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = timeStringToMinutes(workingHours.start);
  const endMinutes = timeStringToMinutes(workingHours.end);
  return nowMinutes >= startMinutes && nowMinutes < endMinutes;
}

/** ローカル日付を YYYY-MM-DD 形式で返す（朝会・夕会の日次 rule_key に使う） */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * items の中から、getTimestamp が返す ISO8601 文字列が最も新しい要素を返す
 * （入力配列は破壊しない）。escalation / silence / break-overrun の各ルールで
 * 「直近の1件」を求める処理を共通化する。
 */
export function latestByTimestamp<T>(
  items: T[],
  getTimestamp: (item: T) => string,
): T | undefined {
  return [...items].sort(
    (a, b) => new Date(getTimestamp(b)).getTime() - new Date(getTimestamp(a)).getTime(),
  )[0];
}
