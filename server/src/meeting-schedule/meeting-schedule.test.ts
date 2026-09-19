import { describe, expect, it, vi } from "vitest";
import {
  MAX_MEETING_DELAY_MINUTES,
  latestAllowedMeetingTime,
  isAllowedMeetingTime,
  resolveEffectiveMeetingTimes,
  type MeetingTimeDefaults,
} from "./meeting-schedule.js";

describe("MAX_MEETING_DELAY_MINUTES", () => {
  it("is 180 minutes (3 hours, 決定7)", () => {
    expect(MAX_MEETING_DELAY_MINUTES).toBe(180);
  });
});

describe("latestAllowedMeetingTime", () => {
  it("returns the default time plus 180 minutes (AC-6)", () => {
    expect(latestAllowedMeetingTime("18:00")).toBe("21:00");
    expect(latestAllowedMeetingTime("09:00")).toBe("12:00");
  });

  it("clamps to 23:59 when default + 180 minutes would exceed the day (AC-7)", () => {
    // 22:30 + 180min = 01:30 (次の日) だが "HH:mm" は日をまたげないため 23:59
    expect(latestAllowedMeetingTime("22:30")).toBe("23:59");
  });

  it("does not clamp when default + 180 minutes lands exactly on 23:59", () => {
    // 20:59 + 180min = 23:59 ちょうど
    expect(latestAllowedMeetingTime("20:59")).toBe("23:59");
  });

  it("falls back to 00:00 as the base when defaultTime is not a valid HH:mm string (defensive: unreachable via loadDetectionSettings)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(latestAllowedMeetingTime("not-a-time")).toBe("03:00");
    warnSpy.mockRestore();
  });
});

describe("isAllowedMeetingTime", () => {
  it("allows the time exactly at the limit (AC-8)", () => {
    expect(isAllowedMeetingTime("18:00", "21:00")).toBe(true);
  });

  it("rejects one minute past the limit (AC-9)", () => {
    expect(isAllowedMeetingTime("18:00", "21:01")).toBe(false);
  });

  it("allows a time earlier than the default (AC-10)", () => {
    expect(isAllowedMeetingTime("09:00", "07:00")).toBe(true);
  });

  it("allows a time equal to the default", () => {
    expect(isAllowedMeetingTime("18:00", "18:00")).toBe(true);
  });

  it("rejects a time well past the limit", () => {
    expect(isAllowedMeetingTime("18:00", "23:59")).toBe(false);
  });
});

describe("resolveEffectiveMeetingTimes", () => {
  const defaults: MeetingTimeDefaults = { morning: "09:00", evening: "18:00" };

  it("falls back to the default time when there is no override for a type (AC-1)", () => {
    const result = resolveEffectiveMeetingTimes(defaults, {});
    expect(result).toEqual({ morning: "09:00", evening: "18:00" });
  });

  it("uses the override time when one is present (AC-2)", () => {
    const result = resolveEffectiveMeetingTimes(defaults, { evening: "21:00" });
    expect(result.evening).toBe("21:00");
  });

  it("leaves the other type at its default when only one type is overridden (AC-3)", () => {
    const result = resolveEffectiveMeetingTimes(defaults, { evening: "21:00" });
    expect(result.morning).toBe("09:00");
  });

  it("falls back to the default when the stored override is not in HH:mm format (AC-4)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveEffectiveMeetingTimes(defaults, { evening: "not-a-time" });
    expect(result.evening).toBe("18:00");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to the default when the stored override exceeds the delay limit (AC-5)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 恒常設定 18:00 の上限は 21:00。22:00 は超過（決定2 合成規則3）。
    const result = resolveEffectiveMeetingTimes(defaults, { evening: "22:00" });
    expect(result.evening).toBe("18:00");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when the override is valid and within the limit", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveEffectiveMeetingTimes(defaults, { evening: "20:00" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("resolves both types independently when both have overrides", () => {
    const result = resolveEffectiveMeetingTimes(defaults, {
      morning: "07:00",
      evening: "20:00",
    });
    expect(result).toEqual({ morning: "07:00", evening: "20:00" });
  });
});
