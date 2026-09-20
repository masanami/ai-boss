import { TIME_PATTERN } from "../detection/detection-types.js";
import { timeStringToMinutes } from "../detection/time-utils.js";

/**
 * 当日限りの朝会・夕会の時刻変更（#432 /
 * docs/features/today-meeting-time-override.md）の合成規則を実装する純粋
 * 関数群。DB にも現在時刻にも触れない（同ファイル「IF（層間の境界となる
 * 契約）」節でシグネチャを固定済み。呼び出し側は保存層〔リポジトリ〕・API
 * 層〔ルータ〕・スケジューラ結合〔#433〕）。
 */

/** 恒常設定からの最大遅延（分）。設定へは露出しない（決定7） */
export const MAX_MEETING_DELAY_MINUTES = 180;

/** 1 日の最終分（23:59）。"HH:mm" は日をまたげないための上限クランプに使う */
const LAST_MINUTE_OF_DAY = 23 * 60 + 59;

export type MeetingType = "morning" | "evening";

/** 種別ごとの恒常設定の時刻（"HH:mm"） */
export type MeetingTimeDefaults = Record<MeetingType, string>;

/** その日に保存されている上書き。行が無い種別はキーを持たない */
export type MeetingTimeOverrides = Partial<Record<MeetingType, string>>;

function minutesToTimeString(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * 指定できる最も遅い時刻。`min(既定 + MAX_MEETING_DELAY_MINUTES, "23:59")`
 * （決定7）。`defaultTime` は呼び出し側（`loadDetectionSettings`）が既に
 * "HH:mm" 形式を保証している前提のため、ここでは書式検証を行わない。
 *
 * その前提が破れた場合（不正な `defaultTime`）は `timeStringToMinutes` が
 * 既に警告ログを出したうえで `null` を返すため、`isAllowedMeetingTime`
 * の不正入力時の扱い（fail-closed）と方向を揃え、既定 0 分（00:00）起点
 * として最も厳しい（早い）上限へ倒す——`??` による暗黙のゼロ埋めではなく、
 * この分岐で明示する。
 */
export function latestAllowedMeetingTime(defaultTime: string): string {
  const defaultMinutes = timeStringToMinutes(defaultTime);
  const baseMinutes = defaultMinutes === null ? 0 : defaultMinutes;
  const cappedMinutes = Math.min(baseMinutes + MAX_MEETING_DELAY_MINUTES, LAST_MINUTE_OF_DAY);
  return minutesToTimeString(cappedMinutes);
}

/**
 * `requestedTime` が `latestAllowedMeetingTime(defaultTime)` 以下か。両方
 * "HH:mm" 形式であることは呼び出し側の責務（決定7: 丸めず拒否する）。
 */
export function isAllowedMeetingTime(defaultTime: string, requestedTime: string): boolean {
  const requestedMinutes = timeStringToMinutes(requestedTime);
  const latestMinutes = timeStringToMinutes(latestAllowedMeetingTime(defaultTime));
  if (requestedMinutes === null || latestMinutes === null) {
    return false;
  }
  return requestedMinutes <= latestMinutes;
}

/**
 * 種別ごとの実効時刻を、決定2の合成規則1〜4に従って解決する。
 *
 * 1. その日・その種別の上書き行が無い → 既定時刻
 * 2. 上書き行の値が `TIME_PATTERN` に合致しない → 既定時刻（警告ログ）
 * 3. 上書き行の値が `latestAllowedMeetingTime` より遅い → 既定時刻（警告ログ）
 * 4. それ以外 → 上書き行の値
 *
 * フォールバックはすべて「既定時刻」へ倒す（黙って消えるより余計に鳴る
 * ほうが回復可能であるため）。
 *
 * 書式検証を `TIME_PATTERN.test()` で自前に行い、`timeStringToMinutes`
 * （`detection/time-utils.ts`）の書式検証には頼らない。同関数は不正な
 * 入力に対して独自に `console.warn` を出す副作用を持つため、そちらに
 * 委ねると規則2の警告ログと二重に出てしまう。ここでは規則2・3それぞれで
 * 1回だけ警告する。
 */
export function resolveEffectiveMeetingTimes(
  defaults: MeetingTimeDefaults,
  overrides: MeetingTimeOverrides,
): Record<MeetingType, string> {
  const result = {} as Record<MeetingType, string>;

  for (const type of Object.keys(defaults) as MeetingType[]) {
    const defaultTime = defaults[type];
    const override = overrides[type];

    if (override === undefined) {
      result[type] = defaultTime;
      continue;
    }

    if (!TIME_PATTERN.test(override)) {
      console.warn(
        `meeting_time_overrides の ${type} の値 ${JSON.stringify(override)} は "HH:mm" 形式ではありません。既定値 ${defaultTime} を使用します。`,
      );
      result[type] = defaultTime;
      continue;
    }

    if (!isAllowedMeetingTime(defaultTime, override)) {
      console.warn(
        `meeting_time_overrides の ${type} の値 "${override}" は上限 ${latestAllowedMeetingTime(defaultTime)} を超えています。既定値 ${defaultTime} を使用します。`,
      );
      result[type] = defaultTime;
      continue;
    }

    result[type] = override;
  }

  return result;
}
