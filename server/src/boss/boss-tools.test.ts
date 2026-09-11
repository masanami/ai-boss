import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { listDecisions } from "../decisions/decisions-repository.js";
import { insertTask, listTasks } from "../tasks/tasks-repository.js";
import { BOSS_TOOLS, executeBossTool } from "./boss-tools.js";

describe("BOSS_TOOLS", () => {
  it("defines create_task, update_task, record_decision, record_mentoring, and get_activity_log", () => {
    expect(BOSS_TOOLS.map((tool) => tool.name)).toEqual([
      "create_task",
      "update_task",
      "record_decision",
      "record_mentoring",
      "get_activity_log",
    ]);
  });
});

describe("executeBossTool", () => {
  let db: Database.Database;
  let sessionId: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    sessionId = insertSession(db, { type: "adhoc" }).id;
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches create_task to the task tools", () => {
    const result = executeBossTool(db, sessionId, "create_task", { title: "資料作成" });

    expect(result.isError).toBe(false);
    expect(listTasks(db)).toHaveLength(1);
  });

  it("dispatches record_decision to the decision tool, using the given session id", () => {
    const result = executeBossTool(db, sessionId, "record_decision", {
      content: "資料作成を最優先にする",
    });

    expect(result.isError).toBe(false);
    const decisions = listDecisions(db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ session_id: sessionId, kind: "decision" });
  });

  it("dispatches record_mentoring to the mentoring tool, using the given session id", () => {
    const result = executeBossTool(db, sessionId, "record_mentoring", {
      content: "見積もりの前提を再確認してから着手する",
    });

    expect(result.isError).toBe(false);
    const decisions = listDecisions(db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ session_id: sessionId, kind: "mentoring" });
  });

  it("returns an error result for an unknown tool name", () => {
    const result = executeBossTool(db, sessionId, "delete_task", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("delete_task");
  });

  it("dispatches get_activity_log without requiring the session id", () => {
    const result = executeBossTool(db, sessionId, "get_activity_log", {});

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content) as { events: unknown[]; truncated: boolean };
    expect(parsed).toMatchObject({ events: [], truncated: false });
  });

  describe("mentoringTaskId fallback dispatch (Issue #469)", () => {
    it("passes mentoringTaskId through to record_mentoring when task_id is omitted (AC-23)", () => {
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

      const result = executeBossTool(
        db,
        sessionId,
        "record_mentoring",
        { content: "見積もりの前提を再確認してから着手する" },
        task.id,
      );

      expect(result.isError).toBe(false);
      const decisions = listDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ task_id: task.id, kind: "mentoring" });
    });

    it("does not overwrite an explicit task_id on record_mentoring with mentoringTaskId (AC-24)", () => {
      const explicitTask = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      const otherTask = insertTask(db, {
        title: "別タスク",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });

      const result = executeBossTool(
        db,
        sessionId,
        "record_mentoring",
        { content: "見積もりの前提を再確認してから着手する", task_id: explicitTask.id },
        otherTask.id,
      );

      expect(result.isError).toBe(false);
      const decisions = listDecisions(db);
      expect(decisions[0]).toMatchObject({ task_id: explicitTask.id });
    });

    it("does not pass mentoringTaskId through to record_decision (AC-27 non-regression)", () => {
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

      const result = executeBossTool(
        db,
        sessionId,
        "record_decision",
        { content: "資料作成を最優先にする" },
        task.id,
      );

      expect(result.isError).toBe(false);
      const decisions = listDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ task_id: null, kind: "decision" });
    });
  });
});
