import { describe, expect, it } from "vitest";
import { isSameLocalDay } from "./is-same-local-day";

describe("isSameLocalDay", () => {
  // Constructed from local (year, monthIndex, day, hour, minute) components
  // rather than ISO/UTC strings so the assertions hold regardless of the
  // machine's timezone.
  it("returns true for two timestamps on the same local calendar day", () => {
    const morning = new Date(2026, 6, 5, 0, 30);
    const evening = new Date(2026, 6, 5, 23, 0);

    expect(isSameLocalDay(morning, evening)).toBe(true);
  });

  it("returns false for timestamps on different calendar days", () => {
    const today = new Date(2026, 6, 5, 9, 0);
    const yesterday = new Date(2026, 6, 4, 9, 0);

    expect(isSameLocalDay(today, yesterday)).toBe(false);
  });

  it("returns false across a local midnight boundary even when close in time", () => {
    const justBeforeMidnight = new Date(2026, 6, 5, 23, 59);
    const justAfterMidnight = new Date(2026, 6, 6, 0, 1);

    expect(isSameLocalDay(justBeforeMidnight, justAfterMidnight)).toBe(false);
  });
});
