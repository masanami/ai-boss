import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { listDecisions } from "../decisions/decisions-repository.js";
import { RECORD_DECISION_TOOL, executeRecordDecisionTool } from "./decision-tool.js";

describe("RECORD_DECISION_TOOL", () => {
  it("is named record_decision and requires content", () => {
    expect(RECORD_DECISION_TOOL.name).toBe("record_decision");
    expect(RECORD_DECISION_TOOL.input_schema.required).toEqual(["content"]);
  });
});

describe("executeRecordDecisionTool", () => {
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

  it("records a decision for the current session and returns it as the tool result content", () => {
    const result = executeRecordDecisionTool(db, sessionId, {
      content: "資料作成を最優先にする",
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({
      session_id: sessionId,
      content: "資料作成を最優先にする",
      status: "active",
    });

    const decisions = listDecisions(db);
    expect(decisions).toHaveLength(1);
  });

  it("returns an error result when content is missing", () => {
    const result = executeRecordDecisionTool(db, sessionId, {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
    expect(listDecisions(db)).toHaveLength(0);
  });

  it("persists rationale when provided", () => {
    const result = executeRecordDecisionTool(db, sessionId, {
      content: "締切を延ばす",
      rationale: "他タスクが優先のため",
    });

    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ rationale: "他タスクが優先のため" });
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

    const result = executeRecordDecisionTool(db, sessionId, {
      content: "締切を延ばす",
      task_id: task.id,
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ task_id: task.id });
  });

  it("treats an explicit null task_id the same as omitted", () => {
    const result = executeRecordDecisionTool(db, sessionId, {
      content: "締切を延ばす",
      task_id: null,
    });

    expect(result.isError).toBe(false);
    const recorded = JSON.parse(result.content);
    expect(recorded).toMatchObject({ task_id: null });
  });

  it("returns an error result and does not persist when task_id does not refer to an existing task", () => {
    const result = executeRecordDecisionTool(db, sessionId, {
      content: "締切を延ばす",
      task_id: 9999,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("9999");
    expect(listDecisions(db)).toHaveLength(0);
  });
});
