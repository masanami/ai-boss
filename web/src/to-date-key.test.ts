import { describe, expect, it } from "vitest";
import { toDateKey } from "./to-date-key";

describe("toDateKey", () => {
  it("formats a date as YYYY-MM-DD with zero-padded month and day", () => {
    expect(toDateKey(new Date(2026, 7, 14))).toBe("2026-08-14");
  });

  it("zero-pads single-digit months and days", () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
