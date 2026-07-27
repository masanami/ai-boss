import { describe, expect, it } from "vitest";
import { selectTodayTasks } from "./today-tasks";
import type { Task } from "./task";

// テストの時刻はローカル日付基準で組み立て、TZ に依存しない値にする。
const NOW = new Date(2026, 6, 27, 12, 0, 0);

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
    created_at: new Date(2026, 6, 25, 9).toISOString(),
    updated_at: new Date(2026, 6, 25, 9).toISOString(),
    completed_at: null,
    ...overrides,
  };
}

describe("selectTodayTasks", () => {
  it("includes todo and in_progress tasks", () => {
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "in_progress" }),
    ];

    expect(selectTodayTasks(tasks, NOW)).toEqual(tasks);
  });

  it("excludes dropped tasks", () => {
    const todo = makeTask({ id: 1, status: "todo" });
    const dropped = makeTask({ id: 2, status: "dropped" });

    expect(selectTodayTasks([todo, dropped], NOW)).toEqual([todo]);
  });

  it("includes done tasks completed today (local date)", () => {
    const doneToday = makeTask({
      id: 1,
      status: "done",
      completed_at: new Date(2026, 6, 27, 9).toISOString(),
    });

    expect(selectTodayTasks([doneToday], NOW)).toEqual([doneToday]);
  });

  it("excludes done tasks completed on a past day", () => {
    const doneYesterday = makeTask({
      id: 1,
      status: "done",
      completed_at: new Date(2026, 6, 26, 23).toISOString(),
    });

    expect(selectTodayTasks([doneYesterday], NOW)).toEqual([]);
  });

  it("excludes done tasks without completed_at", () => {
    const doneWithoutTimestamp = makeTask({
      id: 1,
      status: "done",
      completed_at: null,
    });

    expect(selectTodayTasks([doneWithoutTimestamp], NOW)).toEqual([]);
  });
});
