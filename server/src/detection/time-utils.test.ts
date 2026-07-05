import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clamp,
  diffInMinutes,
  isWithinWorkingHours,
  timeStringToMinutes,
  toDateKey,
} from "./time-utils.js";

describe("clamp", () => {
  it("returns the value unchanged when within range", () => {
    expect(clamp(50, 15, 120)).toBe(50);
  });

  it("clamps to the minimum when below range", () => {
    expect(clamp(5, 15, 120)).toBe(15);
  });

  it("clamps to the maximum when above range", () => {
    expect(clamp(200, 15, 120)).toBe(120);
  });
});

describe("diffInMinutes", () => {
  it("returns the number of minutes elapsed between two dates", () => {
    const earlier = new Date("2026-07-05T09:00:00");
    const later = new Date("2026-07-05T09:30:00");
    expect(diffInMinutes(later, earlier)).toBe(30);
  });
});

describe("timeStringToMinutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts an HH:mm string to minutes since midnight", () => {
    expect(timeStringToMinutes("09:30")).toBe(570);
  });

  it.each(["", "9", "ab:cd", "09:5", "banana"])(
    "returns null and warns for a malformed time string (%j)",
    (input) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(timeStringToMinutes(input)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );

  it.each(["24:00", "09:60"])(
    "returns null and warns for an out-of-range time string (%j)",
    (input) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(timeStringToMinutes(input)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    },
  );
});

describe("isWithinWorkingHours", () => {
  const workingHours = { start: "09:00", end: "18:00" };

  it("returns true when now is inside the window", () => {
    const now = new Date("2026-07-05T12:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(true);
  });

  it("returns true at the exact start boundary", () => {
    const now = new Date("2026-07-05T09:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(true);
  });

  it("returns false at the exact end boundary (end is exclusive)", () => {
    const now = new Date("2026-07-05T18:00:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("returns false before the start", () => {
    const now = new Date("2026-07-05T08:59:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("returns false after the end", () => {
    const now = new Date("2026-07-05T18:01:00");
    expect(isWithinWorkingHours(now, workingHours)).toBe(false);
  });

  it("falls back to the default working hours (09:00-18:00) when the setting is malformed", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const inside = new Date("2026-07-05T12:00:00");
    const outside = new Date("2026-07-05T08:00:00");
    const malformed = { start: "banana", end: "18:00" };

    expect(isWithinWorkingHours(inside, malformed)).toBe(true);
    expect(isWithinWorkingHours(outside, malformed)).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("toDateKey", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    const date = new Date("2026-07-05T23:30:00");
    expect(toDateKey(date)).toBe("2026-07-05");
  });

  it("zero-pads single-digit months and days", () => {
    const date = new Date("2026-01-02T00:00:00");
    expect(toDateKey(date)).toBe("2026-01-02");
  });
});
