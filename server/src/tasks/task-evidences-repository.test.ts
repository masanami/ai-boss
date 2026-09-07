import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "./tasks-repository.js";
import {
  countTaskEvidences,
  deleteTaskEvidence,
  findTaskEvidenceById,
  insertTaskEvidence,
  listTaskEvidences,
} from "./task-evidences-repository.js";

function createTask(db: Database.Database): number {
  const task = insertTask(db, {
    title: "テストタスク",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
  });
  return task.id;
}

describe("task-evidences-repository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("listTaskEvidences", () => {
    it("returns an empty array for a task with no evidences", () => {
      const taskId = createTask(db);

      expect(listTaskEvidences(db, taskId)).toEqual([]);
    });

    it("returns only the evidences belonging to the given task", () => {
      const taskId = createTask(db);
      const otherTaskId = createTask(db);
      insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/a" });
      insertTaskEvidence(db, {
        task_id: otherTaskId,
        kind: "link",
        url: "https://example.com/b",
      });

      const evidences = listTaskEvidences(db, taskId);

      expect(evidences).toHaveLength(1);
      expect(evidences[0].task_id).toBe(taskId);
    });
  });

  describe("insertTaskEvidence", () => {
    it("inserts a file evidence with all file fields populated and url null", () => {
      const taskId = createTask(db);

      const evidence = insertTaskEvidence(db, {
        task_id: taskId,
        kind: "file",
        stored_filename: "generated-name.png",
        original_filename: "screenshot.png",
        mime_type: "image/png",
        size_bytes: 1234,
      });

      expect(evidence.id).toBeGreaterThan(0);
      expect(evidence.kind).toBe("file");
      expect(evidence.stored_filename).toBe("generated-name.png");
      expect(evidence.original_filename).toBe("screenshot.png");
      expect(evidence.mime_type).toBe("image/png");
      expect(evidence.size_bytes).toBe(1234);
      expect(evidence.url).toBeNull();
      expect(typeof evidence.created_at).toBe("string");
      expect(evidence.created_at.length).toBeGreaterThan(0);
    });

    it("inserts a link evidence with url populated and file fields null", () => {
      const taskId = createTask(db);

      const evidence = insertTaskEvidence(db, {
        task_id: taskId,
        kind: "link",
        url: "https://example.com/pr/1",
      });

      expect(evidence.kind).toBe("link");
      expect(evidence.url).toBe("https://example.com/pr/1");
      expect(evidence.stored_filename).toBeNull();
      expect(evidence.original_filename).toBeNull();
      expect(evidence.mime_type).toBeNull();
      expect(evidence.size_bytes).toBeNull();
    });

    it("makes the inserted evidence visible via listTaskEvidences", () => {
      const taskId = createTask(db);

      insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      expect(listTaskEvidences(db, taskId)).toHaveLength(1);
    });
  });

  describe("countTaskEvidences", () => {
    it("returns 0 for a task with no evidences", () => {
      const taskId = createTask(db);

      expect(countTaskEvidences(db, taskId)).toBe(0);
    });

    it("returns the number of evidences for the given task", () => {
      const taskId = createTask(db);
      insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/1" });
      insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/2" });

      expect(countTaskEvidences(db, taskId)).toBe(2);
    });
  });

  describe("findTaskEvidenceById", () => {
    it("returns undefined for a non-existent id", () => {
      expect(findTaskEvidenceById(db, 999999)).toBeUndefined();
    });

    it("returns the evidence row for an existing id", () => {
      const taskId = createTask(db);
      const inserted = insertTaskEvidence(db, {
        task_id: taskId,
        kind: "link",
        url: "https://example.com/x",
      });

      const found = findTaskEvidenceById(db, inserted.id);

      expect(found).toEqual(inserted);
    });
  });

  describe("deleteTaskEvidence", () => {
    it("removes the row and returns true", () => {
      const taskId = createTask(db);
      const inserted = insertTaskEvidence(db, {
        task_id: taskId,
        kind: "link",
        url: "https://example.com/x",
      });

      const result = deleteTaskEvidence(db, inserted.id);

      expect(result).toBe(true);
      expect(findTaskEvidenceById(db, inserted.id)).toBeUndefined();
    });

    it("returns false and does nothing when the id does not exist", () => {
      expect(deleteTaskEvidence(db, 999999)).toBe(false);
    });
  });
});
