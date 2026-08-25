import { describe, expect, it } from "vitest";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "./local-day.js";

describe("startOfNextLocalDayIso", () => {
  it("returns the local midnight of the day after the given date", () => {
    const now = new Date(2026, 6, 5, 15, 30, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2026, 6, 6, 0, 0, 0, 0).toISOString(),
    );
  });

  it("is exactly one calendar day after startOfLocalDayIso for the same input", () => {
    const now = new Date(2026, 6, 5, 15, 30, 0);

    const start = new Date(startOfLocalDayIso(now));
    const nextStart = new Date(startOfNextLocalDayIso(now));

    expect(nextStart.getFullYear()).toBe(start.getFullYear());
    expect(nextStart.getMonth()).toBe(start.getMonth());
    expect(nextStart.getDate()).toBe(start.getDate() + 1);
  });

  it("rolls over into the next month when given the last day of a month", () => {
    const now = new Date(2026, 6, 31, 23, 0, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2026, 7, 1, 0, 0, 0, 0).toISOString(),
    );
  });

  it("rolls over into the next year when given December 31st", () => {
    const now = new Date(2026, 11, 31, 12, 0, 0);

    expect(startOfNextLocalDayIso(now)).toBe(
      new Date(2027, 0, 1, 0, 0, 0, 0).toISOString(),
    );
  });

  it("defaults to advancing from the current time when no argument is given", () => {
    const before = new Date();
    const result = new Date(startOfNextLocalDayIso());
    const after = new Date();

    const expectedFromBefore = new Date(
      before.getFullYear(),
      before.getMonth(),
      before.getDate() + 1,
    );
    const expectedFromAfter = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + 1,
    );

    expect(result.getTime()).toBeGreaterThanOrEqual(expectedFromBefore.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(expectedFromAfter.getTime());
  });
});
