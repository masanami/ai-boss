import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOccurredAtIso, isFutureIso } from "./build-occurred-at-iso";

describe("buildOccurredAtIso: nonexistent local times in a DST gap (Codex P2 on PR #357)", () => {
  // TZ を America/New_York に固定して決定的にする（Node は process.env.TZ の
  // 実行時変更を反映する）。2026-03-08 は春の時刻進行日で 02:00〜02:59 が
  // 存在しない。
  const originalTz = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("rejects 02:30 on the spring-forward day instead of normalizing it to 03:30", () => {
    vi.setSystemTime(new Date(2026, 2, 8, 12, 0, 0, 0));
    // TZ 切り替えが効いていることの確認（切り替え後のニューヨークは UTC-4）
    expect(new Date(2026, 2, 8, 12, 0, 0, 0).getTimezoneOffset()).toBe(240);
    // Date コンストラクタ単体は 02:30 を 03:30 へ丸める（拒否する根拠）
    expect(new Date(2026, 2, 8, 2, 30, 0, 0).getHours()).toBe(3);

    expect(buildOccurredAtIso("02:30")).toBeNull();
  });

  it("accepts 03:30 on the spring-forward day", () => {
    vi.setSystemTime(new Date(2026, 2, 8, 12, 0, 0, 0));

    const iso = buildOccurredAtIso("03:30");
    expect(iso).toBe(new Date(2026, 2, 8, 3, 30, 0, 0).toISOString());
    expect(new Date(iso as string).getHours()).toBe(3);
  });

  it("accepts 02:30 on an ordinary day", () => {
    vi.setSystemTime(new Date(2026, 2, 9, 12, 0, 0, 0));

    const iso = buildOccurredAtIso("02:30");
    expect(iso).toBe(new Date(2026, 2, 9, 2, 30, 0, 0).toISOString());
    expect(new Date(iso as string).getHours()).toBe(2);
    expect(new Date(iso as string).getMinutes()).toBe(30);
  });
});

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

  it("returns null for an out-of-range HH:mm value instead of rolling it over", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 5, 9, 0, 0, 0));

    expect(buildOccurredAtIso("24:00")).toBeNull();
    expect(buildOccurredAtIso("23:60")).toBeNull();
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
