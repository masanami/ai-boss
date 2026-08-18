import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import {
  GET_ACTIVITY_LOG_TOOL,
  executeGetActivityLogTool,
} from "./activity-log-tool.js";

describe("GET_ACTIVITY_LOG_TOOL", () => {
  it("is named get_activity_log and has no required fields", () => {
    expect(GET_ACTIVITY_LOG_TOOL.name).toBe("get_activity_log");
    expect(GET_ACTIVITY_LOG_TOOL.input_schema.required ?? []).toEqual([]);
  });
});

describe("executeGetActivityLogTool", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function insertEvent(params: {
    type: ActivityEvent["type"];
    createdAt: Date;
    taskId?: number | null;
    note?: string | null;
  }): void {
    db.prepare(
      "INSERT INTO activity_events (type, task_id, note, created_at) VALUES (?, ?, ?, ?)",
    ).run(params.type, params.taskId ?? null, params.note ?? null, params.createdAt.toISOString());
  }

  function parseResult(result: { content: string }): { events: ActivityEvent[]; truncated: boolean } {
    return JSON.parse(result.content) as { events: ActivityEvent[]; truncated: boolean };
  }

  it("defaults to today's events (local day boundary) when task_id and since are both omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 15, 30, 0));

    // yesterday, just before local midnight — excluded
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 4, 23, 59, 59, 999) });
    // today, exactly at local midnight — included (inclusive boundary)
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 0, 0, 0, 0) });
    // today, later — included
    insertEvent({ type: "break_start", createdAt: new Date(2026, 6, 5, 10, 0, 0, 0) });

    const result = executeGetActivityLogTool(db, {});

    expect(result.isError).toBe(false);
    const { events, truncated } = parseResult(result);
    expect(events.map((e) => e.type)).toEqual(["checkin", "break_start"]);
    expect(truncated).toBe(false);
  });

  it("returns events from the full history (not just today) when task_id is given and since is omitted", () => {
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });

    // three days before "now" — would be excluded by the "today" default,
    // but must be included when task_id narrows the query (full history).
    insertEvent({
      type: "task_start",
      createdAt: new Date(2026, 6, 2, 9, 0, 0, 0),
      taskId: task.id,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 15, 30, 0));

    const result = executeGetActivityLogTool(db, { task_id: task.id });

    expect(result.isError).toBe(false);
    const { events } = parseResult(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task_start", task_id: task.id });
  });

  it("filters out events for other tasks when task_id is given", () => {
    const taskA = insertTask(db, {
      title: "タスクA",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    const taskB = insertTask(db, {
      title: "タスクB",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });

    insertEvent({ type: "task_start", createdAt: new Date(2026, 6, 5, 9, 0, 0), taskId: taskA.id });
    insertEvent({ type: "task_start", createdAt: new Date(2026, 6, 5, 9, 5, 0), taskId: taskB.id });

    const result = executeGetActivityLogTool(db, { task_id: taskA.id });

    const { events } = parseResult(result);
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe(taskA.id);
  });

  it("narrows results with since and until (inclusive on both ends)", () => {
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 8, 0, 0), note: "before" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 9, 0, 0), note: "in-range-start" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 10, 0, 0), note: "in-range-end" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 11, 0, 0), note: "after" });

    const result = executeGetActivityLogTool(db, {
      since: new Date(2026, 6, 5, 9, 0, 0).toISOString(),
      until: new Date(2026, 6, 5, 10, 0, 0).toISOString(),
    });

    const { events } = parseResult(result);
    expect(events.map((e) => e.note)).toEqual(["in-range-start", "in-range-end"]);
  });

  it("returns up to 100 events, newest-first-truncated but ascending-order in the response, with truncated=true", () => {
    for (let i = 0; i < 105; i += 1) {
      insertEvent({
        type: "checkin",
        createdAt: new Date(2026, 6, 5, 0, i, 0),
        note: `event-${i}`,
      });
    }

    const result = executeGetActivityLogTool(db, {
      since: new Date(2026, 6, 5, 0, 0, 0).toISOString(),
    });

    const { events, truncated } = parseResult(result);
    expect(truncated).toBe(true);
    expect(events).toHaveLength(100);
    // The oldest 5 (event-0..event-4) are dropped; the remaining 100 are
    // still returned oldest-first (ascending).
    expect(events[0].note).toBe("event-5");
    expect(events[99].note).toBe("event-104");
  });

  it("does not truncate when there are exactly 100 matching events", () => {
    for (let i = 0; i < 100; i += 1) {
      insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 0, i, 0) });
    }

    const result = executeGetActivityLogTool(db, {
      since: new Date(2026, 6, 5, 0, 0, 0).toISOString(),
    });

    const { events, truncated } = parseResult(result);
    expect(truncated).toBe(false);
    expect(events).toHaveLength(100);
  });

  it("rejects a non-integer task_id", () => {
    const result = executeGetActivityLogTool(db, { task_id: "1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("task_id");
  });

  it("rejects a since value that is not a string", () => {
    const result = executeGetActivityLogTool(db, { since: 12345 });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("since");
  });

  it("rejects a since value that Date.parse cannot parse", () => {
    const result = executeGetActivityLogTool(db, { since: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("since");
  });

  it("rejects an until value that Date.parse cannot parse", () => {
    const result = executeGetActivityLogTool(db, { until: "also-not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("until");
  });

  it("rejects non-ISO datetime formats that Date.parse would accept (PR #152 review)", () => {
    // Date.parse 単独では受理されてしまう非 ISO 形式・不正値の代表例
    const invalidInputs = [
      "July 5, 2026", // 英語自然文形式
      "2026/07/05", // スラッシュ区切り
      "2026-07-05 12:34:56Z", // T でなく空白区切り
      "2026-02-30T12:00:00Z", // 存在しない暦日（月繰り上げ正規化を拒否）
      "2026-07-05T25:00:00Z", // 時が範囲外
      "2026-07-05T12:60:00Z", // 分が範囲外
    ];

    for (const value of invalidInputs) {
      const result = executeGetActivityLogTool(db, { since: value });
      expect(result.isError, `should reject: ${value}`).toBe(true);
      expect(result.content).toContain("since");
    }
  });

  it("accepts strict ISO 8601 datetime variants (offset / milliseconds / minute precision)", () => {
    const validInputs = [
      "2026-07-05T12:34:56Z",
      "2026-07-05T12:34:56+09:00",
      "2026-07-05T12:34:56.123Z",
      "2026-07-05T12:34",
    ];

    for (const value of validInputs) {
      const result = executeGetActivityLogTool(db, { since: value });
      expect(result.isError, `should accept: ${value}`).not.toBe(true);
    }
  });

  it("rejects a non-object input", () => {
    const result = executeGetActivityLogTool(db, "not-an-object");

    expect(result.isError).toBe(true);
  });

  it("rejects a null input", () => {
    const result = executeGetActivityLogTool(db, null);

    expect(result.isError).toBe(true);
  });

  it("rejects a task_id that does not refer to an existing task (self-review: distinguishes 'no task' from 'no log entries')", () => {
    const result = executeGetActivityLogTool(db, { task_id: 9999 });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("9999");
  });

  it("treats a date-only since/until (e.g. \"2026-07-05\") as local midnight, consistent with the tool's own local-day default (self-review: avoid a silent UTC/local mismatch)", () => {
    // Local midnight of 2026-07-05 up to (but not including) local midnight
    // of 2026-07-06.
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 4, 23, 59, 59, 999), note: "before" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 0, 0, 0, 0), note: "in-range-start" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 5, 23, 59, 59, 999), note: "in-range-end" });
    insertEvent({ type: "checkin", createdAt: new Date(2026, 6, 6, 0, 0, 0, 1), note: "after" });

    const result = executeGetActivityLogTool(db, { since: "2026-07-05", until: "2026-07-05" });

    const { events } = parseResult(result);
    expect(events.map((e) => e.note)).toEqual(["in-range-start", "in-range-end"]);
  });

  it("rejects a date-only since/until that is not a real calendar date", () => {
    const result = executeGetActivityLogTool(db, { since: "2026-02-30" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("since");
  });
});
