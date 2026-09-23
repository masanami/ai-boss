import { describe, expect, it } from "vitest";
import { getActiveBreak, isBreakOverrun } from "./break-overrun.js";
import { makeActivityEvent } from "./detection-test-fixtures.js";

describe("getActiveBreak", () => {
  it("returns the last break_start when there is no matching break_end after it", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T10:00:00.000Z",
    });

    expect(getActiveBreak([breakStart])).toEqual(breakStart);
  });

  it("returns undefined when a break_end followed the last break_start", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T10:00:00.000Z",
    });
    const breakEnd = makeActivityEvent({
      type: "break_end",
      created_at: "2026-07-05T10:10:00.000Z",
    });

    expect(getActiveBreak([breakStart, breakEnd])).toBeUndefined();
  });

  it("returns undefined when there is no break_start at all", () => {
    expect(getActiveBreak([])).toBeUndefined();
  });

  it("uses the most recent break_start when there are multiple break cycles", () => {
    const firstBreakStart = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T08:00:00.000Z",
    });
    const firstBreakEnd = makeActivityEvent({
      type: "break_end",
      created_at: "2026-07-05T08:10:00.000Z",
    });
    const secondBreakStart = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T10:00:00.000Z",
    });

    expect(
      getActiveBreak([firstBreakStart, firstBreakEnd, secondBreakStart]),
    ).toEqual(secondBreakStart);
  });

  it("ignores task_pause events and still returns the active break (#179 判断4: G-179-17 回帰)", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      created_at: "2026-07-05T10:00:00.000Z",
    });
    const taskPauseBefore = makeActivityEvent({
      type: "task_pause",
      task_id: 1,
      created_at: "2026-07-05T09:00:00.000Z",
    });
    const taskPauseAfter = makeActivityEvent({
      type: "task_pause",
      task_id: 2,
      created_at: "2026-07-05T10:05:00.000Z",
    });

    expect(
      getActiveBreak([taskPauseBefore, breakStart, taskPauseAfter]),
    ).toEqual(breakStart);
  });
});

describe("isBreakOverrun", () => {
  it("does not fire before the expected_minutes has elapsed", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      expected_minutes: 15,
      created_at: "2026-07-05T10:00:00.000Z",
    });
    const now = new Date("2026-07-05T10:14:59.000Z");

    expect(isBreakOverrun(breakStart, now, 15)).toBe(false);
  });

  it("fires once the expected_minutes has been exceeded", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      expected_minutes: 15,
      created_at: "2026-07-05T10:00:00.000Z",
    });
    const now = new Date("2026-07-05T10:15:01.000Z");

    expect(isBreakOverrun(breakStart, now, 15)).toBe(true);
  });

  it("falls back to the fallback minutes when expected_minutes is not set", () => {
    const breakStart = makeActivityEvent({
      type: "break_start",
      expected_minutes: null,
      created_at: "2026-07-05T10:00:00.000Z",
    });
    const now = new Date("2026-07-05T10:15:01.000Z");

    expect(isBreakOverrun(breakStart, now, 15)).toBe(true);
  });
});
