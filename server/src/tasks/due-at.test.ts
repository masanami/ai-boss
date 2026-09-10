import { describe, expect, it } from "vitest";
import { normalizeDueAtToDateKey, toDueAtInstant } from "./due-at.js";

describe("toDueAtInstant", () => {
  it("returns null when due_at is null (AC-5)", () => {
    expect(toDueAtInstant(null)).toBeNull();
  });

  it.each([
    "not-a-date-at-all",
    "2026-13-01",
    "2026-09-05T25:00",
    "2026-02-30",
    "12/31/2026",
    "0",
    "",
  ])("returns null for a value that fails isValidIsoDateOrDateTime (%j) (AC-6)", (input) => {
    expect(toDueAtInstant(input)).toBeNull();
  });

  it("returns the epoch ms of the next local calendar day's midnight for a date-only value (AC-7)", () => {
    const expected = new Date(2026, 8, 6).getTime(); // 2026-09-06 00:00 local (due day 2026-09-05 + 1)

    expect(toDueAtInstant("2026-09-05")).toBe(expected);
  });

  it("interprets a legacy time-of-day value as the local calendar day of that instant (AC-12)", () => {
    // "2026-09-05T18:00:00+09:00" の瞬時をローカル暦日として解釈し、その翌暦日
    // 00:00 を返す。期待値はその瞬時から `Date` のローカル getter で導出し、
    // UTC 文字列リテラルで固定しない（ADR 0007 決定 5）。
    const instant = new Date("2026-09-05T18:00:00+09:00");
    const expected = new Date(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate() + 1,
    ).getTime();

    expect(toDueAtInstant("2026-09-05T18:00:00+09:00")).toBe(expected);
  });

  it("interprets a legacy time-of-day value that crosses the local calendar day boundary as the local day of that instant (AC-12)", () => {
    // "2026-09-05T00:30:00+14:00" は UTC では 2026-09-04 のため、実行 TZ に
    // よってはローカル暦日が 9/4 になりうる。期待値は実行 TZ に依存させて
    // 導出し、ハードコードしない。
    const instant = new Date("2026-09-05T00:30:00+14:00");
    const expected = new Date(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate() + 1,
    ).getTime();

    expect(toDueAtInstant("2026-09-05T00:30:00+14:00")).toBe(expected);
  });
});

describe("normalizeDueAtToDateKey", () => {
  it("returns null when due_at is null", () => {
    expect(normalizeDueAtToDateKey(null)).toBeNull();
  });

  it.each([
    "not-a-date-at-all",
    "2026-13-01",
    "2026-09-05T25:00",
    "2026-02-30",
    "12/31/2026",
    "0",
    "",
  ])("returns null for a value that fails isValidIsoDateOrDateTime (%j)", (input) => {
    expect(normalizeDueAtToDateKey(input)).toBeNull();
  });

  it("returns the date key unchanged for an already-normalized date-only value", () => {
    expect(normalizeDueAtToDateKey("2026-09-05")).toBe("2026-09-05");
  });

  it("normalizes a legacy time-of-day value to the local calendar day of that instant (AC-13)", () => {
    const instant = new Date("2026-09-05T18:00:00+09:00");
    const expected = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;

    expect(normalizeDueAtToDateKey("2026-09-05T18:00:00+09:00")).toBe(expected);
  });

  it("normalizes a legacy time-of-day value that crosses the local calendar day boundary to the local day of that instant (AC-13)", () => {
    const instant = new Date("2026-09-05T00:30:00+14:00");
    const expected = `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, "0")}-${String(instant.getDate()).padStart(2, "0")}`;

    expect(normalizeDueAtToDateKey("2026-09-05T00:30:00+14:00")).toBe(expected);
  });
});
