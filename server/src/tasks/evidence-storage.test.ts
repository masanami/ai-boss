import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "./tasks-repository.js";
import { insertTaskEvidence, findTaskEvidenceById } from "./task-evidences-repository.js";
import { deleteEvidence, saveFileEvidence, saveLinkEvidence } from "./evidence-storage.js";

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

describe("evidence-storage", () => {
  let db: Database.Database;
  let evidenceDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    evidenceDir = mkdtempSync(join(tmpdir(), "ai-boss-evidence-"));
  });

  afterEach(() => {
    db.close();
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  describe("saveFileEvidence", () => {
    it("writes the file bytes into the evidence directory (AC-40)", () => {
      const taskId = createTask(db);
      const data = Buffer.from("hello evidence");

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "note.txt",
        data,
      });

      const writtenPath = join(evidenceDir, evidence.stored_filename as string);
      expect(existsSync(writtenPath)).toBe(true);
      expect(readFileSync(writtenPath)).toEqual(data);
    });

    it("generates a stored_filename different from the original filename (AC-41)", () => {
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "screenshot.png",
        data: Buffer.from("fake-png-bytes"),
      });

      expect(evidence.stored_filename).not.toBe("screenshot.png");
    });

    it("preserves the original filename in original_filename", () => {
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "screenshot.png",
        data: Buffer.from("fake-png-bytes"),
      });

      expect(evidence.original_filename).toBe("screenshot.png");
    });

    it("stores stored_filename as a directory-relative name with no path separators (AC-43)", () => {
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "../../etc/passwd.png",
        data: Buffer.from("x"),
      });

      const storedFilename = evidence.stored_filename as string;
      expect(storedFilename).not.toContain("/");
      expect(storedFilename).not.toContain(sep);
      expect(existsSync(join(evidenceDir, storedFilename))).toBe(true);
    });

    it("derives mime_type from the extension, not from any client-provided value", () => {
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "report.pdf",
        data: Buffer.from("%PDF-1.4"),
      });

      expect(evidence.mime_type).toBe("application/pdf");
    });

    it("records size_bytes matching the written data length", () => {
      const taskId = createTask(db);
      const data = Buffer.from("0123456789");

      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "data.txt",
        data,
      });

      expect(evidence.size_bytes).toBe(data.length);
    });

    it("produces a distinct stored_filename for two files with the same original name", () => {
      const taskId = createTask(db);

      const first = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "screenshot.png",
        data: Buffer.from("first"),
      });
      const second = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "screenshot.png",
        data: Buffer.from("second"),
      });

      expect(first.stored_filename).not.toBe(second.stored_filename);
      expect(readdirSync(evidenceDir)).toHaveLength(2);
    });

    it("throws for a disallowed extension and does not write any file", () => {
      const taskId = createTask(db);

      expect(() =>
        saveFileEvidence(db, evidenceDir, {
          taskId,
          originalFilename: "evil.exe",
          data: Buffer.from("MZ"),
        }),
      ).toThrow();
      expect(readdirSync(evidenceDir)).toHaveLength(0);
    });
  });

  describe("saveLinkEvidence", () => {
    it("saves a link evidence row with the given url and no file fields", () => {
      const taskId = createTask(db);

      const evidence = saveLinkEvidence(db, { taskId, url: "https://example.com/pr/1" });

      expect(evidence.kind).toBe("link");
      expect(evidence.url).toBe("https://example.com/pr/1");
      expect(evidence.stored_filename).toBeNull();
    });

    it("does not write any file to the evidence directory", () => {
      const taskId = createTask(db);

      saveLinkEvidence(db, { taskId, url: "https://example.com/pr/1" });

      expect(readdirSync(evidenceDir)).toHaveLength(0);
    });
  });

  describe("deleteEvidence", () => {
    it("removes both the DB row and the file for a file evidence", () => {
      const taskId = createTask(db);
      const evidence = saveFileEvidence(db, evidenceDir, {
        taskId,
        originalFilename: "note.txt",
        data: Buffer.from("bye"),
      });
      const storedPath = join(evidenceDir, evidence.stored_filename as string);
      expect(existsSync(storedPath)).toBe(true);

      const result = deleteEvidence(db, evidenceDir, evidence.id);

      expect(result).toBe(true);
      expect(findTaskEvidenceById(db, evidence.id)).toBeUndefined();
      expect(existsSync(storedPath)).toBe(false);
    });

    it("removes the DB row for a link evidence without touching the filesystem", () => {
      const taskId = createTask(db);
      const evidence = saveLinkEvidence(db, { taskId, url: "https://example.com/x" });

      const result = deleteEvidence(db, evidenceDir, evidence.id);

      expect(result).toBe(true);
      expect(findTaskEvidenceById(db, evidence.id)).toBeUndefined();
    });

    it("returns false and does nothing when the evidence id does not exist", () => {
      expect(deleteEvidence(db, evidenceDir, 999999)).toBe(false);
    });

    it("deletes the DB row before the file, so a row for a manually-inserted evidence whose file never existed is still removable", () => {
      const taskId = createTask(db);
      const evidence = insertTaskEvidence(db, {
        task_id: taskId,
        kind: "file",
        stored_filename: "never-written.png",
        original_filename: "x.png",
        mime_type: "image/png",
        size_bytes: 1,
      });

      const result = deleteEvidence(db, evidenceDir, evidence.id);

      expect(result).toBe(true);
      expect(findTaskEvidenceById(db, evidence.id)).toBeUndefined();
    });
  });
});
