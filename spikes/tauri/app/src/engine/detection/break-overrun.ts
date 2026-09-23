import type { ActivityEvent } from "../activity/activity-event.js";
import { diffInMinutes, latestByTimestamp } from "./time-utils.js";

/**
 * 直近の break_start のうち、その後に break_end が記録されていないもの
 * （＝現在休憩中）を返す。休憩していなければ undefined。
 */
export function getActiveBreak(
  activityEvents: ActivityEvent[],
): ActivityEvent | undefined {
  const breakStarts = activityEvents.filter((event) => event.type === "break_start");
  const lastBreakStart = latestByTimestamp(breakStarts, (event) => event.created_at);
  if (!lastBreakStart) return undefined;

  const lastBreakStartMs = new Date(lastBreakStart.created_at).getTime();
  const hasEndedAfter = activityEvents.some(
    (event) =>
      event.type === "break_end" &&
      new Date(event.created_at).getTime() > lastBreakStartMs,
  );

  return hasEndedAfter ? undefined : lastBreakStart;
}

/**
 * 休憩延伸検知: 申告時間（expected_minutes、無ければフォールバック）を超過しているか
 */
export function isBreakOverrun(
  activeBreak: ActivityEvent,
  now: Date,
  fallbackMinutes: number,
): boolean {
  const expectedMinutes = activeBreak.expected_minutes ?? fallbackMinutes;
  const elapsed = diffInMinutes(now, new Date(activeBreak.created_at));
  return elapsed > expectedMinutes;
}
