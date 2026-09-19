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
  // AC-11: "{種別}_meeting:{YYYY-MM-DD}@{HH:mm}" 形式を返す
  it("builds a rule_key that includes the session type, the local date, and the effective meeting time", () => {
    const now = new Date(2026, 6, 5, 9, 30, 0);

    expect(buildMeetingRuleKey("morning", now, "09:00")).toBe(
      "morning_meeting:2026-07-05@09:00",
    );
  });

  it("differs per day so the rule resets daily", () => {
    const day1 = new Date(2026, 6, 5, 9, 30, 0);
    const day2 = new Date(2026, 6, 6, 9, 30, 0);

    expect(buildMeetingRuleKey("morning", day1, "09:00")).not.toBe(
      buildMeetingRuleKey("morning", day2, "09:00"),
    );
  });

  // AC-12: 返すキーの HH:mm 部分は渡された実効時刻と一致する
  it("reflects the given effective meeting time in the HH:mm portion of the key", () => {
    const now = new Date(2026, 6, 5, 21, 0, 0);

    expect(buildMeetingRuleKey("evening", now, "21:00")).toBe(
      "evening_meeting:2026-07-05@21:00",
    );
  });

  // AC-13: 同じ日・同じ種別でも実効時刻が異なれば返り値が異なる
  it("differs when only the effective meeting time differs (same day, same session type)", () => {
    const now = new Date(2026, 6, 5, 21, 0, 0);

    expect(buildMeetingRuleKey("evening", now, "18:00")).not.toBe(
      buildMeetingRuleKey("evening", now, "21:00"),
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
  // AC-14: 日付部分はローカル暦日（既存の担保を維持）
  it("uses the local calendar date, not the UTC date, near local midnight", () => {
    const lateEvening = new Date(2026, 6, 5, 23, 30, 0);
    const earlyMorning = new Date(2026, 6, 5, 0, 30, 0);

    expect(buildMeetingRuleKey("morning", lateEvening, "09:00")).toBe(
      "morning_meeting:2026-07-05@09:00",
    );
    expect(buildMeetingRuleKey("morning", earlyMorning, "09:00")).toBe(
      "morning_meeting:2026-07-05@09:00",
    );
  });
});
