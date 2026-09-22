import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "./decision";
import type { Task, TaskStatus } from "./task";
import {
  detectTaskStarts,
  isMentoringUnconfirmed,
} from "./task-start-mentoring";

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
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 1,
    session_id: 1,
    task_id: null,
    task_title: null,
    content: "c",
    rationale: null,
    status: "active",
    kind: "mentoring",
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("detectTaskStarts (#566 決定2・決定8)", () => {
  it("returns a task whose status moved from todo to in_progress", () => {
    const previous = [makeTask({ id: 1, status: "todo" })];
    const current = [makeTask({ id: 1, status: "in_progress" })];

    expect(detectTaskStarts(previous, current)).toEqual([current[0]]);
  });

  it("returns nothing on the initial load (no previous tasks) even for in_progress tasks (AC-11)", () => {
    const current = [makeTask({ id: 1, status: "in_progress" })];

    expect(detectTaskStarts([], current)).toEqual([]);
  });

  it.each<[TaskStatus, TaskStatus]>([
    ["paused", "in_progress"],
    ["in_progress", "paused"],
    ["in_progress", "todo"],
    ["todo", "done"],
    ["in_progress", "in_progress"],
    ["todo", "todo"],
  ])("ignores %s -> %s (AC-12)", (from, to) => {
    const previous = [makeTask({ id: 1, status: from })];
    const current = [makeTask({ id: 1, status: to })];

    expect(detectTaskStarts(previous, current)).toEqual([]);
  });

  it("returns only the tasks that moved, in the current list's order, matching by id", () => {
    const previous = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "todo" }),
      makeTask({ id: 3, status: "todo" }),
    ];
    const current = [
      makeTask({ id: 3, status: "in_progress" }),
      makeTask({ id: 2, status: "todo" }),
      makeTask({ id: 1, status: "in_progress" }),
    ];

    expect(detectTaskStarts(previous, current).map((t) => t.id)).toEqual([
      3, 1,
    ]);
  });

  it("does not treat a task that is new in the current list as a transition", () => {
    const current = [makeTask({ id: 9, status: "in_progress" })];

    expect(
      detectTaskStarts([makeTask({ id: 1, status: "todo" })], current),
    ).toEqual([]);
  });
});

describe("isMentoringUnconfirmed (#566 決定3)", () => {
  it("is unconfirmed when estimated_minutes is null even if a mentoring record exists (AC-1)", () => {
    const task = makeTask({ id: 1, estimated_minutes: null });

    expect(
      isMentoringUnconfirmed(task, [makeRecord({ task_id: 1 })]),
    ).toBe(true);
  });

  it("is unconfirmed when the estimate exists but no mentoring record is tied to the task (AC-2)", () => {
    const task = makeTask({ id: 1, estimated_minutes: 30 });

    expect(
      isMentoringUnconfirmed(task, [
        makeRecord({ task_id: 2 }),
        makeRecord({ task_id: null }),
        // 決定・判断の記録は進め方の確認に数えない（明示的な仮定 3）
        makeRecord({ task_id: 1, kind: "decision" }),
      ]),
    ).toBe(true);
  });

  it("is confirmed when the estimate exists and a mentoring record is tied to the task (AC-9)", () => {
    const task = makeTask({ id: 1, estimated_minutes: 30 });

    expect(
      isMentoringUnconfirmed(task, [makeRecord({ task_id: 1 })]),
    ).toBe(false);
  });

  it("counts a withdrawn mentoring record as confirmed (AC-10)", () => {
    const task = makeTask({ id: 1, estimated_minutes: 30 });

    expect(
      isMentoringUnconfirmed(task, [
        makeRecord({ task_id: 1, status: "withdrawn" }),
      ]),
    ).toBe(false);
  });

  it("counts estimated_minutes 0 as an existing estimate (明示的な仮定 2)", () => {
    const task = makeTask({ id: 1, estimated_minutes: 0 });

    expect(
      isMentoringUnconfirmed(task, [makeRecord({ task_id: 1 })]),
    ).toBe(false);
  });
});
