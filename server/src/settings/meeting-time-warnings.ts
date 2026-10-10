import { timeStringToMinutes } from "../detection/time-utils.js";
import { SETTING_LABELS } from "./settings-validation.js";

/**
 * 会の時刻と稼働時間帯の整合警告（#708・機能仕様
 * docs/features/working-hours-intervals.md 決定 17〜22）。
 *
 * 会の時刻が帯の外にあっても保存は受け付ける（決定 17。帯の外の会は正当な
 * 設定）。この関数は「帯とずれている」ことに気付かせる警告だけを組み立てる。
 */
export const MEETING_OUTSIDE_WORKING_HOURS_CODE = "meeting_outside_working_hours";

type MeetingTimeKey = "morning_meeting_time" | "evening_meeting_time";

export type MeetingTimeWarningInput = {
  work_start: string;
  work_end: string;
  morning_meeting_time: string;
  evening_meeting_time: string;
};

export type MeetingTimeWarning = {
  code: typeof MEETING_OUTSIDE_WORKING_HOURS_CODE;
  key: MeetingTimeKey;
  message: string;
};

// 配列の順は朝会→夕会に固定する（仮定 A2）。
const MEETING_TIME_KEYS: readonly MeetingTimeKey[] = [
  "morning_meeting_time",
  "evening_meeting_time",
];

/**
 * 帯の外にある会ごとに 1 件の警告を返す。「帯の中」は両端を含む
 * `[work_start, work_end]`（決定 19。既定の夕会 18:00 = work_end を外に
 * しないため）。検知のゲート `isWithinWorkingHours` の半開区間とは目的が
 * 違うので再利用しない。
 *
 * 入力は書き込み後の実効設定（決定 20）で書式は保証済みだが、万一
 * `timeStringToMinutes` が解析できない値が来たら、その会は判定しない
 * （根拠の無い警告を出さない）。
 */
export function findMeetingTimeWarnings(
  input: MeetingTimeWarningInput,
): MeetingTimeWarning[] {
  const start = timeStringToMinutes(input.work_start);
  const end = timeStringToMinutes(input.work_end);
  if (start === null || end === null) {
    return [];
  }

  const warnings: MeetingTimeWarning[] = [];
  for (const key of MEETING_TIME_KEYS) {
    const time = input[key];
    const minutes = timeStringToMinutes(time);
    if (minutes === null || (minutes >= start && minutes <= end)) {
      continue;
    }
    warnings.push({
      code: MEETING_OUTSIDE_WORKING_HOURS_CODE,
      key,
      message: `${SETTING_LABELS[key]}の時刻（${time}）が勤務時間帯（${input.work_start}〜${input.work_end}）の外にあります`,
    });
  }
  return warnings;
}
