import { describe, expect, it } from "vitest";
import {
  UNASSIGNED_SECTION_TITLE,
  groupDecisionsByTask,
} from "./group-decisions-by-task";
import type { DecisionRecord } from "./decision";

/** Builds a `created_at` from a local wall-clock date so ordering fixtures
 * stay meaningful in any timezone (ADR 0007 決定5). Deliberately not a UTC
 * string literal: what is under test is the relative order of records. */
function at(month: number, day: number, hour: number): string {
  return new Date(2026, month - 1, day, hour).toISOString();
}

function makeDecision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 1,
    session_id: 1,
    task_id: null,
    task_title: null,
    content: "決定内容",
    rationale: null,
    status: "active",
    kind: "decision",
    created_at: at(9, 5, 9),
    ...overrides,
  };
}

describe("groupDecisionsByTask", () => {
  it("returns no sections for an empty list", () => {
    expect(groupDecisionsByTask([])).toEqual([]);
  });

  it("collects records with the same task_id into one section", () => {
    const sections = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 5, task_title: "見積もり", content: "A" }),
      makeDecision({ id: 2, task_id: 5, task_title: "見積もり", content: "B" }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].taskId).toBe(5);
    expect(sections[0].records.map((r) => r.content)).toEqual(["B", "A"]);
  });

  it("heads each section with the task title, not the raw id", () => {
    const [section] = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 5, task_title: "見積もり資料の作成" }),
    ]);

    expect(section.title).toBe("見積もり資料の作成");
  });

  it("orders records within a section newest first, id descending on ties", () => {
    const tie = at(9, 5, 9);
    const [section] = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 5, content: "古い", created_at: at(9, 4, 9) }),
      makeDecision({ id: 2, task_id: 5, content: "同時刻・小さい id", created_at: tie }),
      makeDecision({ id: 3, task_id: 5, content: "同時刻・大きい id", created_at: tie }),
    ]);

    expect(section.records.map((r) => r.content)).toEqual([
      "同時刻・大きい id",
      "同時刻・小さい id",
      "古い",
    ]);
  });

  it("orders task sections by their own newest record, newest first", () => {
    const sections = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 5, task_title: "古いタスク", created_at: at(9, 1, 9) }),
      makeDecision({ id: 2, task_id: 7, task_title: "新しいタスク", created_at: at(9, 6, 9) }),
      makeDecision({ id: 3, task_id: 5, task_title: "古いタスク", created_at: at(9, 3, 9) }),
    ]);

    expect(sections.map((s) => s.title)).toEqual(["新しいタスク", "古いタスク"]);
  });

  it("puts records with no task into a dedicated section", () => {
    const sections = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: null, content: "朝会を 9:30 に変更する" }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].taskId).toBeNull();
    expect(sections[0].title).toBe(UNASSIGNED_SECTION_TITLE);
    expect(sections[0].records.map((r) => r.content)).toEqual([
      "朝会を 9:30 に変更する",
    ]);
  });

  it("keeps the no-task section last even when its records are the newest", () => {
    const sections = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 5, task_title: "タスクA", created_at: at(9, 1, 9) }),
      // 最新だが、タスクに紐づかないので末尾でなければならない
      makeDecision({ id: 2, task_id: null, created_at: at(9, 9, 9) }),
      makeDecision({ id: 3, task_id: 7, task_title: "タスクB", created_at: at(9, 5, 9) }),
    ]);

    expect(sections.map((s) => s.title)).toEqual([
      "タスクB",
      "タスクA",
      UNASSIGNED_SECTION_TITLE,
    ]);
  });

  it("interleaves mentoring and decision records in one section, in time order", () => {
    const [section] = groupDecisionsByTask([
      makeDecision({
        id: 1,
        task_id: 5,
        kind: "decision",
        content: "これを最優先で片付けろ",
        created_at: at(9, 6, 9),
      }),
      makeDecision({
        id: 2,
        task_id: 5,
        kind: "mentoring",
        content: "着手前に前提を確認していない",
        created_at: at(9, 6, 8),
      }),
    ]);

    expect(section.records.map((r) => [r.kind, r.content])).toEqual([
      ["decision", "これを最優先で片付けろ"],
      ["mentoring", "着手前に前提を確認していない"],
    ]);
  });

  it("falls back to the raw id when a task_id has no resolved title", () => {
    const [section] = groupDecisionsByTask([
      makeDecision({ id: 1, task_id: 42, task_title: null }),
    ]);

    expect(section.title).toBe("#42");
  });

  it("does not mutate the input array", () => {
    const records = [
      makeDecision({ id: 1, task_id: 5, created_at: at(9, 1, 9) }),
      makeDecision({ id: 2, task_id: 5, created_at: at(9, 6, 9) }),
    ];
    const snapshot = records.map((r) => r.id);

    groupDecisionsByTask(records);

    expect(records.map((r) => r.id)).toEqual(snapshot);
  });
});
