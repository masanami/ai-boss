import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/task.js";
import { computeTaskFingerprint } from "./task-fingerprint.js";

/**
 * Issue #121: pure-function fingerprint over `listTasks(db)` results, used
 * to invalidate the dashboard "今日のひとこと" cache when task state changes
 * within the same day (not just across a date boundary).
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "タスク",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("computeTaskFingerprint", () => {
  it("is deterministic for the same input", () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })];

    const first = computeTaskFingerprint(tasks);
    const second = computeTaskFingerprint(tasks);

    expect(first).toBe(second);
  });

  it("changes when a task is added", () => {
    const before = [makeTask({ id: 1 })];
    const after = [makeTask({ id: 1 }), makeTask({ id: 2 })];

    expect(computeTaskFingerprint(after)).not.toBe(computeTaskFingerprint(before));
  });

  it("changes when a task's updated_at changes", () => {
    const before = [makeTask({ id: 1, updated_at: "2026-07-06T00:00:00.000Z" })];
    const after = [makeTask({ id: 1, updated_at: "2026-07-06T01:00:00.000Z" })];

    expect(computeTaskFingerprint(after)).not.toBe(computeTaskFingerprint(before));
  });

  it("returns a stable value for zero tasks", () => {
    expect(computeTaskFingerprint([])).toBe(computeTaskFingerprint([]));
    expect(computeTaskFingerprint([])).toEqual(expect.any(String));
    expect(computeTaskFingerprint([]).length).toBeGreaterThan(0);
  });
});
