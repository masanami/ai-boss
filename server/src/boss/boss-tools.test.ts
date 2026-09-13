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

  // 機能仕様 docs/features/task-start-commitment.md 決定3-2（Issue #527）。
  // create_task のツール定義（TASK_TOOLS）に status は無いが、
  // validateCreateTaskInput は executeCreateTask 経由で raw な入力全体を
  // そのまま検証するため、executeBossTool に status を直接渡して拒否を
  // 担保する（Issue #527 本文で親了承済み）。
  describe("committed_start_at の拒否（作成時、決定3-2）", () => {
    it("rejects create_task when status is not todo and committed_start_at is set, and does not create the task (mutation: skip the create-time rejection)", () => {
      const result = executeBossTool(db, sessionId, "create_task", {
        title: "t",
        status: "done",
        committed_start_at: "2026-09-14T20:00:00+09:00",
      });

      expect(result.isError).toBe(true);
      expect(listTasks(db)).toHaveLength(0);
    });
  });

  // 機能仕様 docs/features/task-start-commitment.md 決定6（Issue #525）
  describe("committed_start_at: null via update_task（API バックエンド経路）", () => {
    it("clears committed_start_at and committed_at when { id, committed_start_at: null } is executed directly", () => {
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
      executeBossTool(db, sessionId, "update_task", {
        id: task.id,
        committed_start_at: "2026-09-14T20:00:00+09:00",
      });

      const result = executeBossTool(db, sessionId, "update_task", {
        id: task.id,
        committed_start_at: null,
      });

      expect(result.isError).toBe(false);
      const updated = JSON.parse(result.content);
      expect(updated.committed_start_at).toBeNull();
      expect(updated.committed_at).toBeNull();
    });

    it("records the before/after values in the task_update event note when the commitment is cleared", () => {
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
      executeBossTool(db, sessionId, "update_task", {
        id: task.id,
        committed_start_at: "2026-09-14T20:00:00+09:00",
      });

      executeBossTool(db, sessionId, "update_task", {
        id: task.id,
        committed_start_at: null,
      });

      // 2 件（初期設定 → 取り消し）であることを固定してから 2 件目（取り消し）
      // を見る — id DESC の先頭だけを見ると、取り消しが no-op になった場合に
      // 1 件目（初期設定）のイベントを誤って「取り消しのイベント」として拾って
      // しまい、そちらの note にも偶然 "null"（変更前プレースホルダ）と同じ
      // 日時文字列が含まれるため、変異を検出できなくなる（実測で確認済み）。
      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update' ORDER BY id ASC")
        .all() as { note: string | null }[];
      expect(events).toHaveLength(2);
      expect(events[1].note).toBe("着手の約束を 2026-09-14T11:00:00.000Z から null に変更");
    });
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
