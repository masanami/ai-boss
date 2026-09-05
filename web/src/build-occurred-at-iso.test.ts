import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOccurredAtIso, isFutureIso } from "./build-occurred-at-iso";

describe("buildOccurredAtIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("anchors the HH:mm value to today's local calendar date", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 5, 9, 0, 0, 0));

    expect(buildOccurredAtIso("08:30")).toBe(
      new Date(2026, 8, 5, 8, 30, 0, 0).toISOString(),
    );
  });

  it("returns null for an empty string", () => {
    expect(buildOccurredAtIso("")).toBeNull();
  });

  it("returns null for a malformed HH:mm value", () => {
    expect(buildOccurredAtIso("8:30")).toBeNull();
    expect(buildOccurredAtIso("08:30:00")).toBeNull();
    expect(buildOccurredAtIso("not-a-time")).toBeNull();
  });
});

describe("isFutureIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when the ISO datetime is after now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 5, 9, 0, 0, 0));

    expect(isFutureIso(new Date(2026, 8, 5, 10, 0, 0, 0).toISOString())).toBe(
      true,
    );
  });

  it("returns false when the ISO datetime is at or before now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 5, 9, 0, 0, 0));

    expect(isFutureIso(new Date(2026, 8, 5, 9, 0, 0, 0).toISOString())).toBe(
      false,
    );
    expect(isFutureIso(new Date(2026, 8, 5, 8, 0, 0, 0).toISOString())).toBe(
      false,
    );
  });
});
