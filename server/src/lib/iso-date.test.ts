import { describe, expect, it } from "vitest";

import { isValidIsoDateOrDateTime } from "./iso-date.js";

describe("isValidIsoDateOrDateTime", () => {
  it("accepts a date-only value produced by the web date input", () => {
    expect(isValidIsoDateOrDateTime("2026-09-05")).toBe(true);
  });

  it("accepts full ISO 8601 date-times produced by the boss tool use path", () => {
    for (const valid of [
      "2026-09-05T09:30",
      "2026-09-05T09:30:00",
      "2026-09-05T09:30:00.123",
      "2026-09-05T09:30:00Z",
      "2026-09-05T09:30:00.123Z",
      "2026-09-05T09:30:00+09:00",
      "2026-09-05T09:30:00-05:00",
    ]) {
      expect(isValidIsoDateOrDateTime(valid), valid).toBe(true);
    }
  });

  it("accepts a leap day in a leap year", () => {
    expect(isValidIsoDateOrDateTime("2028-02-29")).toBe(true);
  });

  it("rejects free-form strings that Date would silently accept or reject", () => {
    for (const invalid of [
      "not-a-date-at-all",
      "",
      "0",
      "2026",
      "12/31/2026",
      "December 5, 2026",
      "2026-09-05T09:30:00 and then some",
    ]) {
      expect(isValidIsoDateOrDateTime(invalid), invalid).toBe(false);
    }
  });

  it("rejects calendar dates that do not exist instead of letting Date roll them over", () => {
    for (const invalid of [
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2027-02-29",
      "2026-09-00",
    ]) {
      expect(isValidIsoDateOrDateTime(invalid), invalid).toBe(false);
    }
  });

  it("rejects out-of-range time components", () => {
    for (const invalid of [
      "2026-09-05T24:00",
      "2026-09-05T09:60",
      "2026-09-05T09:30:60",
    ]) {
      expect(isValidIsoDateOrDateTime(invalid), invalid).toBe(false);
    }
  });
});
