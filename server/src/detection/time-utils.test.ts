import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clamp,
  diffInMinutes,
  isWithinWorkingHours,
  timeStringToMinutes,
  toDateKey,
  toLocalOffset,
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

// 実行環境のタイムゾーンに依存しない形で検証する（ADR 0007 決定 5 と同じ
// 精神をオフセットにも及ぼす）。期待値へ "+09:00" のような固定値を書かず、
// 形式と、`getTimezoneOffset()` との整合だけを見る。
describe("toLocalOffset", () => {
  // -0 を +0 へ畳む。UTC ではオフセットが 0 になり、符号の掛け算（および
  // getTimezoneOffset() の符号反転）から -0 が生じる。`toBe` は Object.is
  // 比較で -0 と +0 を別物として扱うため、正規化しないと UTC 環境でだけ
  // 落ちる（分の値としては同一であり、区別に意味は無い）。
  function normalizeZero(minutes: number): number {
    return minutes === 0 ? 0 : minutes;
  }

  it("formats the local UTC offset as ±HH:MM", () => {
    const date = new Date(2026, 8, 5, 14, 32);

    expect(toLocalOffset(date)).toMatch(/^[+-]\d{2}:\d{2}$/);
  });

  it("returns an offset whose sign and magnitude match getTimezoneOffset()", () => {
    const date = new Date(2026, 8, 5, 14, 32);
    // getTimezoneOffset() は「UTC からの遅れ」を分で返すため符号が逆になる
    const expectedMinutes = -date.getTimezoneOffset();

    const [, sign, hours, minutes] =
      /^([+-])(\d{2}):(\d{2})$/.exec(toLocalOffset(date)) ?? [];
    const actualMinutes =
      (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));

    expect(normalizeZero(actualMinutes)).toBe(normalizeZero(expectedMinutes));
  });
});
