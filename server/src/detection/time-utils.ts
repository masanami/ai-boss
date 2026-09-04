import { DEFAULT_DETECTION_SETTINGS } from "./detection-types.js";
import type { WorkingHours } from "./detection-types.js";

/** 値を [min, max] の範囲に収める */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** later - earlier の経過時間を分単位で返す */
export function diffInMinutes(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / (60 * 1000);
}

const TIME_STRING_PATTERN = /^\d{1,2}:\d{2}$/;

/**
 * "HH:mm" 形式の文字列を、真夜中からの経過分に変換する。
 * 不正な形式（桁欠け・非数字・範囲外）は NaN 伝播で検知が静かに機能停止
 * しないよう、警告ログを出して null を返す（フォールバックは呼び出し側）。
 */
export function timeStringToMinutes(time: string): number | null {
  if (!TIME_STRING_PATTERN.test(time)) {
    console.warn(
      `invalid time string (expected "HH:mm"): ${JSON.stringify(time)}`,
    );
    return null;
  }
  const [hours, minutes] = time.split(":").map(Number);
  if (hours > 23 || minutes > 59) {
    console.warn(
      `invalid time string (out of range): ${JSON.stringify(time)}`,
    );
    return null;
  }
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
  if (startMinutes === null || endMinutes === null) {
    // 不正な設定値で検知全体が静かに停止（常に false）しないよう、既定の
    // 勤務時間帯にフォールバックする（timeStringToMinutes が警告ログ済み）
    return isWithinWorkingHours(now, DEFAULT_DETECTION_SETTINGS.workingHours);
  }
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
 * ローカルタイムゾーンの UTC オフセットを `±HH:MM` 形式で返す
 * （`2026-09-05T14:32+09:00` のようなオフセット付き ISO の組み立てに使う）。
 * `Date` に該当するメソッドが無いため `getTimezoneOffset()` から導出する。
 * 同メソッドは「UTC からの遅れ」を分で返すため、符号は反転させる。
 */
export function toLocalOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
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
