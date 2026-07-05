import type { SessionType } from "../sessions/session.js";
import { timeStringToMinutes, toDateKey } from "./time-utils.js";

type MeetingSessionType = Extract<SessionType, "morning" | "evening">;

function isMeetingTimePassed(now: Date, meetingTime: string): boolean {
  const meetingMinutes = timeStringToMinutes(meetingTime);
  if (meetingMinutes === null) {
    // 不正な設定時刻では意図した時刻が分からないため発火しない
    // （timeStringToMinutes が警告ログ済み）
    return false;
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= meetingMinutes;
}

/**
 * 朝会・夕会定時通知: 設定時刻を過ぎており、当日その種別のセッションがまだ
 * 開始されていないか。勤務時間帯ゲート・休憩ゲートの対象外（呼び出し側で
 * ゲートせず常に評価する）。
 */
export function isMeetingDue(
  now: Date,
  meetingTime: string,
  sessionType: MeetingSessionType,
  todaysSessionTypes: SessionType[],
): boolean {
  if (!isMeetingTimePassed(now, meetingTime)) return false;
  return !todaysSessionTypes.includes(sessionType);
}

/** 朝会・夕会の rule_key（日次でリセットされるよう日付を含める） */
export function buildMeetingRuleKey(
  sessionType: MeetingSessionType,
  now: Date,
): string {
  return `${sessionType}_meeting:${toDateKey(now)}`;
}
