import { describe, expect, it } from "vitest";
import { hasRecentActivityOnOtherTasks } from "./avoidance.js";
import { makeActivityEvent, makeTask } from "./detection-test-fixtures.js";

describe("hasRecentActivityOnOtherTasks", () => {
  it("returns true when another task had a task_start within the window", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_start",
        task_id: 2,
        created_at: "2026-07-05T09:45:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(true);
  });

  it("returns true when another task had a task_update within the window", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_update",
        task_id: 2,
        created_at: "2026-07-05T09:45:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(true);
  });

  it("returns false when the activity is older than the window", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_start",
        task_id: 2,
        created_at: "2026-07-05T09:29:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(false);
  });

  it("returns false when the activity is on the top-priority task itself", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_start",
        task_id: 1,
        created_at: "2026-07-05T09:45:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(false);
  });

  it("returns false for activity types unrelated to task work (e.g. checkin)", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "checkin",
        task_id: 2,
        created_at: "2026-07-05T09:45:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(false);
  });

  it("returns false when the event timestamp is in the future (clock skew)", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_start",
        task_id: 2,
        created_at: "2026-07-05T10:05:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(false);
  });

  it("returns false when task_id is null", () => {
    const topTask = makeTask({ id: 1 });
    const now = new Date("2026-07-05T10:00:00.000Z");
    const events = [
      makeActivityEvent({
        type: "task_start",
        task_id: null,
        created_at: "2026-07-05T09:45:00.000Z",
      }),
    ];

    expect(hasRecentActivityOnOtherTasks(topTask, now, events, 30)).toBe(false);
  });
});
