import { describe, expect, it, vi } from "vitest";
import { buildMeetingRuleKey, isMeetingDue } from "./meeting.js";

describe("isMeetingDue", () => {
  it("fires when the meeting time has passed and no session of that type started today", () => {
    const now = new Date(2026, 6, 5, 9, 0, 0);

    expect(isMeetingDue(now, "09:00", "morning", [])).toBe(true);
  });

  it("does not fire before the meeting time", () => {
    const now = new Date(2026, 6, 5, 8, 59, 0);

    expect(isMeetingDue(now, "09:00", "morning", [])).toBe(false);
  });

  it("does not fire once the session type has already started today", () => {
    const now = new Date(2026, 6, 5, 9, 30, 0);

    expect(isMeetingDue(now, "09:00", "morning", ["morning"])).toBe(false);
  });

  it("evaluates the evening meeting independently of the morning session", () => {
    const now = new Date(2026, 6, 5, 18, 30, 0);

    expect(isMeetingDue(now, "18:00", "evening", ["morning"])).toBe(true);
  });

  it("does not fire (and warns) when the configured meeting time is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = new Date(2026, 6, 5, 9, 30, 0);

    expect(isMeetingDue(now, "banana", "morning", [])).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("buildMeetingRuleKey", () => {
  it("builds a rule_key that includes the session type and the local date", () => {
    const now = new Date(2026, 6, 5, 9, 30, 0);

    expect(buildMeetingRuleKey("morning", now)).toBe("morning_meeting:2026-07-05");
  });

  it("differs per day so the rule resets daily", () => {
    const day1 = new Date(2026, 6, 5, 9, 30, 0);
    const day2 = new Date(2026, 6, 6, 9, 30, 0);

    expect(buildMeetingRuleKey("morning", day1)).not.toBe(
      buildMeetingRuleKey("morning", day2),
    );
  });

  // #305: 上記の 09:30 固定時刻はローカル日と UTC 日が一致する帯なので、
  // `toDateKey`（内部で使用）がローカル暦日ではなく UTC 暦日に退行しても
  // Asia/Tokyo・America/New_York のいずれでも検出できない（実測済み）。
  // 下記の lateEvening（23:30）は America/New_York での退行検出用で、
  // `npm run test:tz`（`TZ=America/New_York`）が実行するためスクリプト化された
  // 実行で担保される。earlyMorning（00:30）は Asia/Tokyo での退行検出用だが、
  // `package.json` の `test:tz` は America/New_York のみのため、Asia/Tokyo 側は
  // 手動実測でのみ確認済み（スクリプト化はしていない）。両方とも
  // `TZ=<該当TZ> npm test` で実際に fail することを実測確認済み。
  it("uses the local calendar date, not the UTC date, near local midnight", () => {
    const lateEvening = new Date(2026, 6, 5, 23, 30, 0);
    const earlyMorning = new Date(2026, 6, 5, 0, 30, 0);

    expect(buildMeetingRuleKey("morning", lateEvening)).toBe("morning_meeting:2026-07-05");
    expect(buildMeetingRuleKey("morning", earlyMorning)).toBe("morning_meeting:2026-07-05");
  });
});
