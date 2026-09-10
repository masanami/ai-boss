import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { listDecisions } from "../decisions/decisions-repository.js";
import { RECORD_MENTORING_TOOL, executeRecordMentoringTool } from "./mentoring-tool.js";

describe("RECORD_MENTORING_TOOL", () => {
  it("is named record_mentoring and requires content", () => {
    expect(RECORD_MENTORING_TOOL.name).toBe("record_mentoring");
    expect(RECORD_MENTORING_TOOL.input_schema.required).toEqual(["content"]);
  });
});

describe("executeRecordMentoringTool", () => {
  let db: Database.Database;
  let sessionId: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    sessionId = insertSession(db, { type: "morning" }).id;
  });

  afterEach(() => {
    db.close();
  });

  it("records a mentoring conclusion for the current session with kind 'mentoring'", () => {
    const result = executeRecordMentoringTool(db, sessionId, {
      content: "見積もりの前提を再確認してから着手する",
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({
      session_id: sessionId,
      content: "見積もりの前提を再確認してから着手する",
      status: "active",
      kind: "mentoring",
    });

    const decisions = listDecisions(db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe("mentoring");
  });

  it("returns an error result when content is missing", () => {
    const result = executeRecordMentoringTool(db, sessionId, {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
    expect(listDecisions(db)).toHaveLength(0);
  });

  it("persists rationale when provided", () => {
    const result = executeRecordMentoringTool(db, sessionId, {
      content: "見積もりの前提を再確認してから着手する",
      rationale: "着手前提の仕様確認が漏れていた",
    });

    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ rationale: "着手前提の仕様確認が漏れていた" });
  });

  it("persists task_id when it refers to an existing task", () => {
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

    const result = executeRecordMentoringTool(db, sessionId, {
      content: "見積もりの前提を再確認してから着手する",
      task_id: task.id,
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ task_id: task.id });
  });

  it("treats an explicit null task_id the same as omitted", () => {
    const result = executeRecordMentoringTool(db, sessionId, {
      content: "見積もりの前提を再確認してから着手する",
      task_id: null,
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ task_id: null });
  });

  it("returns an error result and does not persist when task_id does not refer to an existing task", () => {
    const result = executeRecordMentoringTool(db, sessionId, {
      content: "見積もりの前提を再確認してから着手する",
      task_id: 9999,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("9999");
    expect(listDecisions(db)).toHaveLength(0);
  });

  describe("mentoringTaskId fallback (Issue #469)", () => {
    it("fills task_id from mentoringTaskId when task_id is omitted (AC-23)", () => {
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

      const result = executeRecordMentoringTool(
        db,
        sessionId,
        { content: "見積もりの前提を再確認してから着手する" },
        task.id,
      );

      expect(result.isError).toBe(false);
      const recorded = JSON.parse(result.content);
      expect(recorded).toMatchObject({ task_id: task.id, kind: "mentoring" });

      const decisions = listDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].task_id).toBe(task.id);
    });

    it("keeps the explicit task_id when the boss specifies one, not overwritten by mentoringTaskId (AC-24)", () => {
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

      const result = executeRecordMentoringTool(
        db,
        sessionId,
        { content: "見積もりの前提を再確認してから着手する", task_id: explicitTask.id },
        otherTask.id,
      );

      expect(result.isError).toBe(false);
      const recorded = JSON.parse(result.content);
      expect(recorded).toMatchObject({ task_id: explicitTask.id });
    });

    it("errors on an explicit nonexistent task_id even when mentoringTaskId points to a valid task (explicit does not silently fall back)", () => {
      const validTask = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });

      const result = executeRecordMentoringTool(
        db,
        sessionId,
        { content: "見積もりの前提を再確認してから着手する", task_id: 9999 },
        validTask.id,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("9999");
      expect(listDecisions(db)).toHaveLength(0);
    });

    it("keeps task_id null when mentoringTaskId is not supplied and task_id is omitted (AC-25)", () => {
      const result = executeRecordMentoringTool(db, sessionId, {
        content: "見積もりの前提を再確認してから着手する",
      });

      expect(result.isError).toBe(false);
      const recorded = JSON.parse(result.content);
      expect(recorded).toMatchObject({ task_id: null });
    });

    it("applies mentoringTaskId when task_id is explicitly null (treated as omitted)", () => {
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

      const result = executeRecordMentoringTool(
        db,
        sessionId,
        { content: "見積もりの前提を再確認してから着手する", task_id: null },
        task.id,
      );

      expect(result.isError).toBe(false);
      const recorded = JSON.parse(result.content);
      expect(recorded).toMatchObject({ task_id: task.id });
    });

    it("returns an error and does not persist when mentoringTaskId does not refer to an existing task", () => {
      const result = executeRecordMentoringTool(
        db,
        sessionId,
        { content: "見積もりの前提を再確認してから着手する" },
        9999,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("9999");
      expect(listDecisions(db)).toHaveLength(0);
    });
  });
});
