import { describe, expect, it } from "vitest";
import { deriveIsOnBreak } from "./derive-break-status";
import type { ActivityEvent } from "./activity-event";

function makeEvent(overrides: Partial<ActivityEvent> & { id: number }): ActivityEvent {
  return {
    type: "checkin",
    task_id: null,
    note: null,
    expected_minutes: null,
    created_at: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveIsOnBreak", () => {
  it("returns false when there are no events", () => {
    expect(deriveIsOnBreak([])).toBe(false);
  });

  it("returns false when there is no break_start event", () => {
    const events = [makeEvent({ id: 1, type: "task_start", task_id: 1 })];
    expect(deriveIsOnBreak(events)).toBe(false);
  });

  it("returns true when the last break_start has no following break_end", () => {
    const events = [
      makeEvent({ id: 1, type: "task_start", task_id: 1 }),
      makeEvent({ id: 2, type: "break_start", expected_minutes: 15 }),
    ];
    expect(deriveIsOnBreak(events)).toBe(true);
  });

  it("returns false when a break_end follows the break_start", () => {
    const events = [
      makeEvent({ id: 1, type: "break_start", expected_minutes: 15 }),
      makeEvent({ id: 2, type: "break_end" }),
    ];
    expect(deriveIsOnBreak(events)).toBe(false);
  });

  it("returns true when a second break_start has no following break_end", () => {
    const events = [
      makeEvent({ id: 1, type: "break_start", expected_minutes: 15 }),
      makeEvent({ id: 2, type: "break_end" }),
      makeEvent({ id: 3, type: "break_start", expected_minutes: 5 }),
    ];
    expect(deriveIsOnBreak(events)).toBe(true);
  });
});
