import { describe, expect, it } from "vitest";
import { computeSilenceThresholdMinutes, isSilent } from "./silence.js";
import { DEFAULT_DETECTION_SETTINGS } from "./detection-types.js";
import { makeActivityEvent, makeTask } from "./detection-test-fixtures.js";

const silenceSettings = DEFAULT_DETECTION_SETTINGS.silence;

describe("computeSilenceThresholdMinutes", () => {
  it("falls back to 45min when there is no in-progress task with estimated_minutes", () => {
    expect(computeSilenceThresholdMinutes([], [], silenceSettings)).toBe(45);
  });

  it("scales the threshold from the estimated_minutes of the last task_start target", () => {
    const task = makeTask({ id: 1, estimated_minutes: 60 });
    const events = [
      makeActivityEvent({ type: "task_start", task_id: 1, created_at: "2026-07-05T09:00:00.000Z" }),
    ];

    expect(computeSilenceThresholdMinutes(events, [task], silenceSettings)).toBe(45);
  });

  it("clamps the scaled threshold down to the 90min ceiling", () => {
    const task = makeTask({ id: 1, estimated_minutes: 300 });
    const events = [
      makeActivityEvent({ type: "task_start", task_id: 1, created_at: "2026-07-05T09:00:00.000Z" }),
    ];

    expect(computeSilenceThresholdMinutes(events, [task], silenceSettings)).toBe(90);
  });

  it("clamps the scaled threshold up to the 20min floor", () => {
    const task = makeTask({ id: 1, estimated_minutes: 10 });
    const events = [
      makeActivityEvent({ type: "task_start", task_id: 1, created_at: "2026-07-05T09:00:00.000Z" }),
    ];

    expect(computeSilenceThresholdMinutes(events, [task], silenceSettings)).toBe(20);
  });

  it("uses the most recent task_start when there have been several", () => {
    const oldTask = makeTask({ id: 1, estimated_minutes: 10 });
    const newTask = makeTask({ id: 2, estimated_minutes: 60 });
    const events = [
      makeActivityEvent({ type: "task_start", task_id: 1, created_at: "2026-07-05T08:00:00.000Z" }),
      makeActivityEvent({ type: "task_start", task_id: 2, created_at: "2026-07-05T09:00:00.000Z" }),
    ];

    expect(
      computeSilenceThresholdMinutes(events, [oldTask, newTask], silenceSettings),
    ).toBe(45);
  });
});

describe("isSilent", () => {
  it("returns false when there is no activity history at all (no baseline)", () => {
    const now = new Date("2026-07-05T12:00:00.000Z");

    expect(isSilent(now, [], [], silenceSettings)).toBe(false);
  });

  it("does not fire just before the threshold", () => {
    const events = [
      makeActivityEvent({ type: "checkin", created_at: "2026-07-05T09:00:00.000Z" }),
    ];
    const now = new Date("2026-07-05T09:44:59.000Z");

    expect(isSilent(now, events, [], silenceSettings)).toBe(false);
  });

  it("fires exactly at the threshold", () => {
    const events = [
      makeActivityEvent({ type: "checkin", created_at: "2026-07-05T09:00:00.000Z" }),
    ];
    const now = new Date("2026-07-05T09:45:00.000Z");

    expect(isSilent(now, events, [], silenceSettings)).toBe(true);
  });
});
