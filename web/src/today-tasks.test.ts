import { describe, expect, it } from "vitest";
import { partitionTodayTasks, selectTodayTasks } from "./today-tasks";
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
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
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

  it("includes paused tasks (G-179-11)", () => {
    const todo = makeTask({ id: 1, status: "todo" });
    const paused = makeTask({ id: 2, status: "paused" });

    expect(selectTodayTasks([todo, paused], NOW)).toEqual([todo, paused]);
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

describe("partitionTodayTasks", () => {
  it("puts todo, in_progress and paused tasks into pending (AC-17)", () => {
    const todo = makeTask({ id: 1, status: "todo" });
    const inProgress = makeTask({ id: 2, status: "in_progress" });
    const paused = makeTask({ id: 3, status: "paused" });

    const { pending, done } = partitionTodayTasks([todo, inProgress, paused]);

    expect(pending).toEqual([todo, inProgress, paused]);
    expect(done).toEqual([]);
  });

  it("puts done tasks into done (AC-18)", () => {
    const doneTask = makeTask({
      id: 1,
      status: "done",
      completed_at: new Date(2026, 6, 27, 9).toISOString(),
    });

    const { pending, done } = partitionTodayTasks([doneTask]);

    expect(pending).toEqual([]);
    expect(done).toEqual([doneTask]);
  });

  it("keeps each group's order matching the input order (AC-19)", () => {
    const todo = makeTask({ id: 1, status: "todo" });
    const doneFirst = makeTask({
      id: 2,
      status: "done",
      completed_at: new Date(2026, 6, 27, 9).toISOString(),
    });
    const inProgress = makeTask({ id: 3, status: "in_progress" });
    const doneSecond = makeTask({
      id: 4,
      status: "done",
      completed_at: new Date(2026, 6, 27, 10).toISOString(),
    });

    const { pending, done } = partitionTodayTasks([
      todo,
      doneFirst,
      inProgress,
      doneSecond,
    ]);

    expect(pending).toEqual([todo, inProgress]);
    expect(done).toEqual([doneFirst, doneSecond]);
  });

  it("does not mutate the input array (AC-20)", () => {
    const todo = makeTask({ id: 1, status: "todo" });
    const doneTask = makeTask({
      id: 2,
      status: "done",
      completed_at: new Date(2026, 6, 27, 9).toISOString(),
    });
    const tasks = [todo, doneTask];
    const snapshot = [...tasks];

    partitionTodayTasks(tasks);

    expect(tasks).toEqual(snapshot);
  });
});
