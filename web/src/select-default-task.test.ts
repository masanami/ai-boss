import { describe, expect, it } from "vitest";
import { selectDefaultTask } from "./select-default-task";
import type { Task } from "./task";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `task-${overrides.id}`,
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("selectDefaultTask", () => {
  it("returns undefined for an empty list", () => {
    expect(selectDefaultTask([])).toBeUndefined();
  });

  it("returns the high priority task over medium/low/unset ones", () => {
    const low = makeTask({ id: 1, priority: "low" });
    const high = makeTask({ id: 2, priority: "high" });
    const medium = makeTask({ id: 3, priority: "medium" });
    const unset = makeTask({ id: 4, priority: null });

    expect(selectDefaultTask([low, high, medium, unset])).toEqual(high);
  });

  it("breaks ties between equal priorities by the smaller id", () => {
    const second = makeTask({ id: 5, priority: "high" });
    const first = makeTask({ id: 2, priority: "high" });

    expect(selectDefaultTask([second, first])).toEqual(first);
  });
});
