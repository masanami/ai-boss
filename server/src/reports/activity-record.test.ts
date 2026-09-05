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

/** 対象暦日 2026-08-14 の翌ローカル暦日 00:00（集計の排他上限） */
const NEXT_DAY_START = localIso(2026, 8, 15, 0, 0);

describe("computeActivityRecord — 着手 (firstTaskStartAt)", () => {
  it("returns null when there are no task_start events", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [],
      breakEnds: [],
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(2);
  });

  it("does not count an orphan break_end (no matching break_start) towards breakCount", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [],
      breakEnds: [event(1, localIso(2026, 8, 14, 10, 10))],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(0);
  });

  it("does not count a break_start at or after nextDayStartIso (a next-day break passed in for pairing only), while still counting the last in-range one (#237)", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [
        event(1, localIso(2026, 8, 14, 23, 59, 59)), // 上限直前は数える（対照）
        event(2, localIso(2026, 8, 15, 0, 0)), // 翌暦日 00:00 ちょうど＝対象外
        event(3, localIso(2026, 8, 15, 0, 30)),
      ],
      breakEnds: [],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 15, 1, 0),
    });

    expect(result.breakCount).toBe(1);
  });
});

describe("computeActivityRecord — 休憩合計時間 (breakTotalMinutes) の対応付け", () => {
  it("pairs a single break_start with the break_end that follows it", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 10, 0))],
      breakEnds: [event(2, localIso(2026, 8, 14, 10, 15))],
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    // 10分 + 20分
    expect(result.breakTotalMinutes).toBe(30);
  });

  it("closes an open break at the moment a second break_start arrives (only one break can be open at a time), so overlapping breaks are never double-counted (#237 rule)", () => {
    // 10:00 start, 10:05 start（先行休憩を 10:05 で暗黙に閉じる）, 10:20 end（10:05 の
    // 休憩を閉じる）, 10:30 end（開いている休憩が無い＝孤立・無視）
    // → 5分 + 15分 = 20分。FIFO だと 10:00→10:20 と 10:05→10:30 で 45 分になり
    // 10:05〜10:20 の重なりを二重計上する。
    const firstStart = event(1, localIso(2026, 8, 14, 10, 0));
    const secondStart = event(2, localIso(2026, 8, 14, 10, 5));
    const firstEnd = event(3, localIso(2026, 8, 14, 10, 20));
    const secondEnd = event(4, localIso(2026, 8, 14, 10, 30));

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [firstStart, secondStart],
      breakEnds: [firstEnd, secondEnd],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakCount).toBe(2);
    expect(result.breakTotalMinutes).toBe(5 + 15);
  });

  it("counts an unresponded break_start (no break_end found) through the evening session's ended_at", () => {
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 19, 50))],
      breakEnds: [],
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
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
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 15, 0, 30),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(10);
  });

  it("lets a next-day break_start take the next-day break_end instead of a target-day open break, and excludes that next-day break from the totals (#237: 23:00 start, 00:30 start, 01:00 end, session ends 01:30 → 90 min)", () => {
    // 窓を対称にした収集層から、翌暦日に始まった休憩の start/end も渡ってくる。
    // 23:00 の休憩は 00:30 の break_start で閉じる（90 分）。00:30→01:00 の休憩は
    // 対象暦日外なので回数にも合計にも入らない。
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 23, 0)), event(2, localIso(2026, 8, 15, 0, 30))],
      breakEnds: [event(3, localIso(2026, 8, 15, 1, 0))],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 15, 1, 30),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(90);
  });

  it("clamps to 0 minutes (never negative) when an unresponded break_start begins after the evening session's ended_at", () => {
    // 夕会が 19:00-19:30 で終了した後、23:00 に休憩を開始してまだ戻ってきて
    // いない状態で日報を再生成するケース（CodeRabbit 指摘: 打ち切り時刻
    // sessionEndedAt が start より前になり、対応なしのまま計算すると
    // durationMs が負になっていた）。
    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [event(1, localIso(2026, 8, 14, 23, 0))],
      breakEnds: [],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 19, 30),
    });

    expect(result.breakCount).toBe(1);
    expect(result.breakTotalMinutes).toBe(0);
  });

  it("floors the total to whole minutes when a break duration includes leftover seconds", () => {
    const start = event(1, localIso(2026, 8, 14, 10, 0, 0));
    const end = event(2, localIso(2026, 8, 14, 10, 1, 59));

    const result = computeActivityRecord({
      taskStarts: [],
      breakStarts: [start],
      breakEnds: [end],
      nextDayStartIso: NEXT_DAY_START,
      sessionEndedAt: localIso(2026, 8, 14, 20, 0),
    });

    expect(result.breakTotalMinutes).toBe(1);
  });
});
