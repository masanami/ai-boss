import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import { TASK_TOOLS, executeTaskTool } from "./task-tools.js";

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
});

describe("executeTaskTool", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
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
        due_at: "2026-07-10T00:00:00.000Z",
        estimated_minutes: 30,
        boss_comment: "最優先で進めろ",
      });

      const created = JSON.parse(result.content);
      expect(created).toMatchObject({
        priority: "high",
        due_at: "2026-07-10T00:00:00.000Z",
        estimated_minutes: 30,
        boss_comment: "最優先で進めろ",
      });
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
  });

  describe("unknown tool name", () => {
    it("returns an error result", () => {
      const result = executeTaskTool(db, "delete_task", {});

      expect(result.isError).toBe(true);
      expect(result.content).toContain("delete_task");
    });
  });
});
