import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { setSettingValue } from "../settings/settings-repository.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import { TASK_TOOLS, executeTaskTool } from "./task-tools.js";
import { toDateKey } from "../detection/time-utils.js";

function enableEnforcement(db: Database.Database): void {
  setSettingValue(db, "evidence_enforcement_enabled", "true");
}

describe("TASK_TOOLS", () => {
  it("defines exactly create_task and update_task", () => {
    expect(TASK_TOOLS.map((tool) => tool.name)).toEqual([
      "create_task",
      "update_task",
    ]);
  });

  it("requires title for create_task", () => {
    const createTaskTool = TASK_TOOLS.find((tool) => tool.name === "create_task");
    expect(createTaskTool?.input_schema.required).toEqual(["title"]);
  });

  it("requires id for update_task", () => {
    const updateTaskTool = TASK_TOOLS.find((tool) => tool.name === "update_task");
    expect(updateTaskTool?.input_schema.required).toEqual(["id"]);
  });

  // AC-15: ボスに公開する due_at の説明文が "YYYY-MM-DD" を求める文言であること。
  // 実測（ADR 0010 背景）では、ここが「ISO 8601 日時文字列」だったために LLM が
  // 就業終わりの T18:00:00+09:00 を自分で補い、DB の締切 5 件すべてが時刻付きに
  // なっていた。書き手が LLM である以上、求める形は説明文が決める。
  it.each(["create_task", "update_task"])(
    "asks for a YYYY-MM-DD due_at in the %s schema (AC-15)",
    (toolName) => {
      const tool = TASK_TOOLS.find((t) => t.name === toolName);
      const dueAt = tool?.input_schema.properties?.due_at as
        | { description?: string }
        | undefined;

      expect(dueAt?.description).toContain("YYYY-MM-DD");
      expect(dueAt?.description).not.toContain("日時");
    },
  );
});

describe("executeTaskTool", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 12, 0, 0));
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe("create_task", () => {
    it("creates a task and returns it as the tool result content", () => {
      const result = executeTaskTool(db, "create_task", { title: "資料作成" });

      expect(result.isError).toBe(false);
      const created = JSON.parse(result.content);
      expect(created).toMatchObject({ title: "資料作成", status: "todo", category: "work" });
    });

    it("returns an error result when title is missing", () => {
      const result = executeTaskTool(db, "create_task", {});

      expect(result.isError).toBe(true);
      expect(result.content).toContain("title");
    });

    it("respects optional fields (priority, due_at, estimated_minutes, boss_comment)", () => {
      const result = executeTaskTool(db, "create_task", {
        title: "資料作成",
        priority: "high",
        due_at: "2026-07-10",
        estimated_minutes: 30,
        boss_comment: "最優先で進めろ",
      });

      const created = JSON.parse(result.content);
      expect(created).toMatchObject({
        priority: "high",
        due_at: "2026-07-10",
        estimated_minutes: 30,
        boss_comment: "最優先で進めろ",
      });
    });

    // AC-14（ボスのツール経路）: ボスが時刻付きの旧形式を送ってきても拒否せず
    // 受理し、その瞬時のローカル暦日へ正規化して保存する（ADR 0010 決定 3・4）。
    // 実測では、ボスは説明文に引きずられて T18:00:00+09:00 を送っていた。
    it("normalizes a legacy time-of-day due_at to a local calendar day (AC-14)", () => {
      const legacy = "2026-07-10T18:00:00+09:00";
      const result = executeTaskTool(db, "create_task", {
        title: "資料作成",
        due_at: legacy,
      });

      expect(result.isError).toBe(false);
      const created = JSON.parse(result.content);
      // 期待値はハードコードしない（オフセット付きの値のローカル暦日は実行 TZ で
      // 変わる。America/New_York では 7/10 05:00 なので 7/10、UTC-11 なら 7/9）
      expect(created.due_at).toBe(toDateKey(new Date(legacy)));
      expect(created.due_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // AC-14（ボスのツール経路・update）: 更新経路も同じく暦日へ落とす
    it("normalizes a legacy time-of-day due_at on update too (AC-14)", () => {
      const created = JSON.parse(
        executeTaskTool(db, "create_task", { title: "資料作成" }).content,
      );
      const legacy = "2026-07-11T18:00:00+09:00";

      const updated = JSON.parse(
        executeTaskTool(db, "update_task", { id: created.id, due_at: legacy })
          .content,
      );

      expect(updated.due_at).toBe(toDateKey(new Date(legacy)));
      expect(updated.due_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // 機能仕様 docs/features/completion-evidence-enforcement.md 決定3
    it("sets evidence_required: true when passed explicitly (AC-15)", () => {
      const result = executeTaskTool(db, "create_task", {
        title: "資料作成",
        evidence_required: true,
      });

      const created = JSON.parse(result.content);
      expect(created.evidence_required).toBe(true);
    });

    it("defaults evidence_required to false when omitted (AC-16)", () => {
      const result = executeTaskTool(db, "create_task", { title: "資料作成" });

      const created = JSON.parse(result.content);
      expect(created.evidence_required).toBe(false);
    });
  });

  describe("update_task", () => {
    it("updates an existing task and returns it as the tool result content", () => {
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

      const result = executeTaskTool(db, "update_task", {
        id: task.id,
        priority: "high",
      });

      expect(result.isError).toBe(false);
      const updated = JSON.parse(result.content);
      expect(updated).toMatchObject({ id: task.id, priority: "high" });
    });

    it("returns an error result when id is missing", () => {
      const result = executeTaskTool(db, "update_task", { priority: "high" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("id");
    });

    it("returns an error result when the task does not exist", () => {
      const result = executeTaskTool(db, "update_task", { id: 9999, priority: "high" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("9999");
    });

    it("returns an error result when a field violates validation constraints (invalid status)", () => {
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

      const result = executeTaskTool(db, "update_task", { id: task.id, status: "urgent" });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("status");
    });

    it("records a task_update activity event on success", () => {
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

      executeTaskTool(db, "update_task", { id: task.id, priority: "high" });

      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "task_update", task_id: task.id });
    });

    it("does not record a task_update activity event when the task does not exist", () => {
      executeTaskTool(db, "update_task", { id: 9999, priority: "high" });

      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(events).toHaveLength(0);
    });

    // AC-19（Issue #188）: TASK_STATUSES を spread しているため、#183 の定数
    // 拡張で自動的に受理される見込みだったことをテストで担保する。
    it("accepts status: 'paused' and transitions the task to paused", () => {
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "in_progress",
        boss_comment: null,
        estimated_minutes: null,
      });

      const result = executeTaskTool(db, "update_task", {
        id: task.id,
        status: "paused",
      });

      expect(result.isError).toBe(false);
      const updated = JSON.parse(result.content);
      expect(updated).toMatchObject({ id: task.id, status: "paused" });
    });

    // 親 #179 の明示的な仮定4: ボスが update_task で paused にしても task_pause
    // イベントは記録されない（task_update のみ）。チェックインパネル経由の
    // 「一時停止」（task_pause + task_update の2件）とは非対称。既存の
    // 「ボスが in_progress にしても task_start は記録されない」と同じ非対称性
    // であり、本チケットでは揃えない（抑制の実装を足さない・既存挙動の固定）。
    it("does not record a task_pause activity event when the boss pauses a task via update_task (仮定4の既存非対称性)", () => {
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "in_progress",
        boss_comment: null,
        estimated_minutes: null,
      });

      executeTaskTool(db, "update_task", { id: task.id, status: "paused" });

      const pauseEvents = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_pause'")
        .all() as ActivityEvent[];
      expect(pauseEvents).toHaveLength(0);

      const updateEvents = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(updateEvents).toHaveLength(1);
      expect(updateEvents[0]).toMatchObject({ type: "task_update", task_id: task.id });
    });

    // 機能仕様 docs/features/completion-evidence-enforcement.md 決定2-e
    describe("evidence_required の完了ゲート（Issue #389）", () => {
      it("returns isError: true when evidence is required, enforcement is on, and there is no evidence (AC-32)", () => {
        const task = insertTask(db, {
          title: "資料作成",
          description: null,
          category: "work",
          priority: null,
          due_at: null,
          status: "todo",
          boss_comment: null,
          estimated_minutes: null,
          evidence_required: true,
        });
        enableEnforcement(db);

        const result = executeTaskTool(db, "update_task", {
          id: task.id,
          status: "done",
        });

        expect(result.isError).toBe(true);
      });

      it("the error result text mentions the evidence shortfall (AC-33)", () => {
        const task = insertTask(db, {
          title: "資料作成",
          description: null,
          category: "work",
          priority: null,
          due_at: null,
          status: "todo",
          boss_comment: null,
          estimated_minutes: null,
          evidence_required: true,
        });
        enableEnforcement(db);

        const result = executeTaskTool(db, "update_task", {
          id: task.id,
          status: "done",
        });

        expect(result.content).toContain("エビデンス");
      });

      it("does not record a task_update event when the gate rejects the update", () => {
        const task = insertTask(db, {
          title: "資料作成",
          description: null,
          category: "work",
          priority: null,
          due_at: null,
          status: "todo",
          boss_comment: null,
          estimated_minutes: null,
          evidence_required: true,
        });
        enableEnforcement(db);

        executeTaskTool(db, "update_task", { id: task.id, status: "done" });

        const events = db
          .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
          .all() as ActivityEvent[];
        expect(events).toHaveLength(0);
      });
    });
  });

  describe("unknown tool name", () => {
    it("returns an error result", () => {
      const result = executeTaskTool(db, "delete_task", {});

      expect(result.isError).toBe(true);
      expect(result.content).toContain("delete_task");
    });
  });
});
