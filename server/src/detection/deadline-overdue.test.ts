import { describe, expect, it } from "vitest";
import { findOverdueTasks } from "./deadline-overdue.js";
import { makeTask } from "./detection-test-fixtures.js";

describe("findOverdueTasks", () => {
  it("returns a todo task whose due_at is in the past", () => {
    const overdue = makeTask({
      status: "todo",
      due_at: "2026-07-05T00:00:00.000Z",
    });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([overdue], now)).toEqual([overdue]);
  });

  it("does not include a task exactly at its due_at (not yet overdue)", () => {
    const task = makeTask({ status: "todo", due_at: "2026-07-05T00:00:00.000Z" });
    const now = new Date("2026-07-05T00:00:00.000Z");

    expect(findOverdueTasks([task], now)).toEqual([]);
  });

  it("does not include a task with no due_at", () => {
    const task = makeTask({ status: "todo", due_at: null });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([task], now)).toEqual([]);
  });

  it("does not include done or dropped tasks even if overdue", () => {
    const done = makeTask({ status: "done", due_at: "2026-07-05T00:00:00.000Z" });
    const dropped = makeTask({ status: "dropped", due_at: "2026-07-05T00:00:00.000Z" });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([done, dropped], now)).toEqual([]);
  });

  it("includes an overdue in_progress task", () => {
    const inProgress = makeTask({
      status: "in_progress",
      due_at: "2026-07-05T00:00:00.000Z",
    });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([inProgress], now)).toEqual([inProgress]);
  });

  it("returns every overdue task, not just the top-priority one", () => {
    const first = makeTask({ id: 1, status: "todo", due_at: "2026-07-04T00:00:00.000Z" });
    const second = makeTask({ id: 2, status: "todo", due_at: "2026-07-05T00:00:00.000Z" });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([first, second], now)).toEqual([first, second]);
  });

  it("includes an overdue paused task (#179 判断4: G-179-8)", () => {
    const paused = makeTask({
      status: "paused",
      due_at: "2026-07-05T00:00:00.000Z",
    });
    const now = new Date("2026-07-05T00:00:01.000Z");

    expect(findOverdueTasks([paused], now)).toEqual([paused]);
  });
});
