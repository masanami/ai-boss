import { describe, expect, it } from "vitest";
import { computeUnstartedThresholdMinutes, isTopTaskUnstarted } from "./unstarted.js";
import { DEFAULT_DETECTION_SETTINGS } from "./detection-types.js";
import { makeTask } from "./detection-test-fixtures.js";

const unstartedSettings = DEFAULT_DETECTION_SETTINGS.unstarted;

describe("computeUnstartedThresholdMinutes", () => {
  it("uses the fallback (60min) when estimated_minutes is not set", () => {
    const task = makeTask({ estimated_minutes: null });

    expect(computeUnstartedThresholdMinutes(task, unstartedSettings)).toBe(60);
  });

  it("scales estimated_minutes at a 1.0 factor within the clamp range", () => {
    const task = makeTask({ estimated_minutes: 45 });

    expect(computeUnstartedThresholdMinutes(task, unstartedSettings)).toBe(45);
  });

  it("clamps small estimated_minutes up to the 15min floor", () => {
    const task = makeTask({ estimated_minutes: 5 });

    expect(computeUnstartedThresholdMinutes(task, unstartedSettings)).toBe(15);
  });

  it("clamps large estimated_minutes down to the 120min ceiling", () => {
    const task = makeTask({ estimated_minutes: 300 });

    expect(computeUnstartedThresholdMinutes(task, unstartedSettings)).toBe(120);
  });
});

describe("isTopTaskUnstarted", () => {
  it("does not fire just before the threshold", () => {
    const task = makeTask({
      status: "todo",
      estimated_minutes: 30,
      created_at: "2026-07-05T09:00:00.000Z",
    });
    const now = new Date("2026-07-05T09:29:59.000Z");

    expect(isTopTaskUnstarted(task, now, unstartedSettings)).toBe(false);
  });

  it("fires exactly at the threshold", () => {
    const task = makeTask({
      status: "todo",
      estimated_minutes: 30,
      created_at: "2026-07-05T09:00:00.000Z",
    });
    const now = new Date("2026-07-05T09:30:00.000Z");

    expect(isTopTaskUnstarted(task, now, unstartedSettings)).toBe(true);
  });

  it("does not fire when the task is already in_progress", () => {
    const task = makeTask({
      status: "in_progress",
      estimated_minutes: 30,
      created_at: "2026-07-05T09:00:00.000Z",
    });
    const now = new Date("2026-07-05T10:00:00.000Z");

    expect(isTopTaskUnstarted(task, now, unstartedSettings)).toBe(false);
  });
});
