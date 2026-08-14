import { describe, expect, it } from "vitest";
import { computeActivityRecord } from "./activity-record.js";
import type { ActivityRecordEvent } from "./activity-record.js";

function event(id: number, createdAt: string): ActivityRecordEvent {
  return { id, created_at: createdAt };
}

// ローカル日付基準・TZ非依存: new Date(y, m, d, h, mi) から toISOString() で
// DB 用の値を作る（CLAUDE.md「テスト方針」）。
function localIso(y: number, m: number, d: number, h: number, mi: number, s = 0): string {
  return new Date(y, m - 1, d, h, mi, s).toISOString();
}

describe("computeActivityRecord — 着手 (firstTaskStartAt)", () => {
  it("returns null when there are no task_start events", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.firstTaskStartAt).toBeNull();
  });

  it("returns the earliest task_start timestamp when there is one", () => {
    const only = event(1, localIso(2026, 8, 14, 9, 15));

    const result = computeActivityRecord({
      taskStarts: [only],
      breakStarts: [],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.firstTaskStartAt).toBe(only.created_at);
  });

  it("picks the earliest among multiple task_start events regardless of input order", () => {
    const later = event(2, localIso(2026, 8, 14, 13, 0));
    const earlier = event(1, localIso(2026, 8, 14, 9, 15));

    const result = computeActivityRecord({
      taskStarts: [later, earlier],
      breakStarts: [],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.firstTaskStartAt).toBe(earlier.created_at);
  });

  it("breaks ties on identical created_at by id ascending", () => {
    const sameTimeA = localIso(2026, 8, 14, 9, 0);
    const higherId = event(2, sameTimeA);
    const lowerId = event(1, sameTimeA);

    const result = computeActivityRecord({
      taskStarts: [higherId, lowerId],
      breakStarts: [],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.firstTaskStartAt).toBe(lowerId.created_at);
  });
});

describe("computeActivityRecord — 休憩回数 (breakCount)", () => {
  it("is 0 when there are no break_start events", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(0);
  });

  it("counts every break_start, including ones that never got a matching break_end", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [
        event(1, localIso(2026, 8, 14, 10, 0)),
        event(2, localIso(2026, 8, 14, 14, 0)),
      ],
      breakEnds: [event(3, localIso(2026, 8, 14, 10, 10))],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(2);
  });

  it("does not count an orphan break_end (no matching break_start) towards breakCount", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [],
      breakEnds: [event(1, localIso(2026, 8, 14, 10, 10))],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(0);
  });
});

describe("computeActivityRecord — 休憩合計時間 (breakTotalMinutes) の対応付け", () => {
  it("pairs a single break_start with the break_end that follows it (FIFO)", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 10, 0))],
      breakEnds: [event(2, localIso(2026, 8, 14, 10, 15))],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakTotalMinutes).toBe(15);
  });

  it("pairs multiple non-overlapping breaks and sums their durations", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [
        event(1, localIso(2026, 8, 14, 10, 0)),
        event(3, localIso(2026, 8, 14, 14, 0)),
      ],
      breakEnds: [
        event(2, localIso(2026, 8, 14, 10, 10)),
        event(4, localIso(2026, 8, 14, 14, 20)),
      ],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    // 10分 + 20分
    expect(result.breakTotalMinutes).toBe(30);
  });

  it("pairs each break_start with the first unmatched break_end when two breaks are open before any ends (FIFO)", () => {
    const firstStart = event(1, localIso(2026, 8, 14, 10, 0));
    const secondStart = event(2, localIso(2026, 8, 14, 10, 5));
    const firstEnd = event(3, localIso(2026, 8, 14, 10, 20)); // → firstStart (20分)
    const secondEnd = event(4, localIso(2026, 8, 14, 10, 30)); // → secondStart (25分)

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [firstStart, secondStart],
      breakEnds: [firstEnd, secondEnd],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakTotalMinutes).toBe(20 + 25);
  });

  it("counts an unresponded break_start (no break_end found) through the evening session's ended_at", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 19, 50))],
      breakEnds: [],
      sessionEndedAt: localIso(2026, 8, 14, 20, 30),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(40);
  });

  it("ignores an orphan break_end and does not let it consume a later break_start's pairing", () => {
    const orphanEnd = event(1, localIso(2026, 8, 14, 9, 0));
    const realStart = event(2, localIso(2026, 8, 14, 10, 0));
    const realEnd = event(3, localIso(2026, 8, 14, 10, 15));

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [realStart],
      breakEnds: [orphanEnd, realEnd],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(15);
  });

  it("breaks ties on identical created_at by id ascending (a start and end at the same instant pair start-then-end)", () => {
    const sameTime = localIso(2026, 8, 14, 10, 0);
    const start = event(1, sameTime);
    const end = event(2, sameTime);

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [start],
      breakEnds: [end],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakTotalMinutes).toBe(0);
  });

  it("handles the day-crossing break: 23:55 start, 00:05 end next day, evening session ends 00:30 → 10 minutes", () => {
    const start = event(1, localIso(2026, 8, 14, 23, 55));
    const end = event(2, localIso(2026, 8, 15, 0, 5));

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [start],
      breakEnds: [end],
      sessionEndedAt: localIso(2026, 8, 15, 0, 30),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(10);
  });

  it("floors the total to whole minutes when a break duration includes leftover seconds", () => {
    const start = event(1, localIso(2026, 8, 14, 10, 0, 0));
    const end = event(2, localIso(2026, 8, 14, 10, 1, 59));

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [start],
      breakEnds: [end],
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakTotalMinutes).toBe(1);
  });
});
