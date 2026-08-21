import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/task.js";
import { calculateProgress } from "./progress.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "資料作成",
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

describe("calculateProgress", () => {
  it("returns 0/0 with ratio 0 when there are no target tasks", () => {
    const now = new Date(2026, 6, 6, 10, 0);

    const result = calculateProgress([], now);

    expect(result).toEqual({ done: 0, total: 0, ratio: 0 });
  });

  it("counts todo/in_progress tasks toward total but not done", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "in_progress" }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 0, total: 2, ratio: 0 });
  });

  it("counts tasks completed today toward both done and total", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({
        id: 2,
        status: "done",
        completed_at: new Date(2026, 6, 6, 9, 0).toISOString(),
      }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 1, total: 2, ratio: 0.5 });
  });

  it("excludes dropped tasks entirely", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "dropped" }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 0, total: 1, ratio: 0 });
  });

  it("counts paused tasks toward total but not done (G-179-10)", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "paused" }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 0, total: 2, ratio: 0 });
  });

  it("excludes tasks completed on a previous local day", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({
        id: 1,
        status: "done",
        completed_at: new Date(2026, 6, 5, 23, 59).toISOString(),
      }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 0, total: 0, ratio: 0 });
  });

  it("returns ratio 1 when every target task is done", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({
        id: 1,
        status: "done",
        completed_at: new Date(2026, 6, 6, 9, 0).toISOString(),
      }),
      makeTask({
        id: 2,
        status: "done",
        completed_at: new Date(2026, 6, 6, 9, 30).toISOString(),
      }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 2, total: 2, ratio: 1 });
  });

  it("computes a fractional ratio (2/5 = 0.4)", () => {
    const now = new Date(2026, 6, 6, 10, 0);
    const tasks = [
      makeTask({
        id: 1,
        status: "done",
        completed_at: new Date(2026, 6, 6, 8, 0).toISOString(),
      }),
      makeTask({
        id: 2,
        status: "done",
        completed_at: new Date(2026, 6, 6, 9, 0).toISOString(),
      }),
      makeTask({ id: 3, status: "todo" }),
      makeTask({ id: 4, status: "todo" }),
      makeTask({ id: 5, status: "in_progress" }),
    ];

    const result = calculateProgress(tasks, now);

    expect(result).toEqual({ done: 2, total: 5, ratio: 0.4 });
  });
});
