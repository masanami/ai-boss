import type { SessionType } from "../sessions/session.js";
import { timeStringToMinutes, toDateKey } from "./time-utils.js";

export type MeetingSessionType = Extract<SessionType, "morning" | "evening">;

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

/**
 * 朝会・夕会の rule_key（日次でリセットされるよう日付を含める）。
 *
 * `meetingTime`（当日の実効時刻。#432 の当日上書きが合成済みの値）も埋め込む
 * ことで、当日だけ時刻をずらした場合に別の rule_key として扱われ、
 * `resolveEscalation`（escalation.ts）が新しいキーの履歴無しから
 * 必ず L1 で再開する（機能仕様 docs/features/today-meeting-time-override.md
 * 決定6）。通知履歴（notifications テーブル）は削除・改変しない。
 *
 * `rule_key` を解析している呼び出し元は無い（等値比較とログ出力のみ）ため、
 * 形式を変えても既存の消費者への影響は無い（決定6で確認済み）。
 *
 * **この形式へのアップグレード当日の一過性の帰結（想定内・バグではない）**:
 * 旧形式（`@{HH:mm}` 無し）のキーで既に発火済みの会があると、アップグレード後
 * 最初の tick では新形式のキーに履歴が無いため L1 で 1 回だけ再発火する
 * （既に会を実施済みなら `isMeetingDue` が false のため発火しない）。
 * 「通知が1回余分に出る」側であり、通知が消える側には倒れない。
 */
export function buildMeetingRuleKey(
  sessionType: MeetingSessionType,
  now: Date,
  meetingTime: string,
): string {
  return `${sessionType}_meeting:${toDateKey(now)}@${meetingTime}`;
}
