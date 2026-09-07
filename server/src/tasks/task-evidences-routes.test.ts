import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "./tasks-repository.js";
import { insertTaskEvidence } from "./task-evidences-repository.js";
import type { TaskEvidence } from "./task-evidence.js";

interface ErrorBody {
  error: string;
  code?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createTask(
  db: Database.Database,
  overrides: { status?: "todo" | "in_progress" | "paused" | "done" | "dropped" } = {},
): number {
  const task = insertTask(db, {
    title: "テストタスク",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: overrides.status ?? "todo",
    boss_comment: null,
    estimated_minutes: null,
  });
  return task.id;
}

describe("task evidences routes", () => {
  let db: Database.Database;
  let evidenceDir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    evidenceDir = mkdtempSync(join(tmpdir(), "ai-boss-evidence-routes-"));
  });

  afterEach(() => {
    db.close();
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  describe("GET /api/tasks/:id/evidences", () => {
    it("returns an empty array for a task with no evidences (AC-53)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);

      const res = await app.request(`/api/tasks/${taskId}/evidences`);

      expect(res.status).toBe(200);
      expect(await readJson<TaskEvidence[]>(res)).toEqual([]);
    });

    it("returns 404 for a non-existent task id", async () => {
      const app = createApp(db, process.env, { evidenceDir });

      const res = await app.request(`/api/tasks/9999/evidences`);

      expect(res.status).toBe(404);
    });

    it("returns metadata without the file body (AC-54)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      const res = await app.request(`/api/tasks/${taskId}/evidences`);

      const body = await readJson<TaskEvidence[]>(res);
      expect(body).toHaveLength(1);
      expect(body[0]).not.toHaveProperty("data");
      expect(body[0].kind).toBe("link");
    });
  });

  describe("POST /api/tasks/:id/evidences (multipart file)", () => {
    it("returns 201 and metadata for an allowed file (AC-39)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1, 2, 3])], "note.txt", { type: "text/plain" }));

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(201);
      const body = await readJson<TaskEvidence>(res);
      expect(body.kind).toBe("file");
      expect(body.original_filename).toBe("note.txt");
    });

    it("persists the original filename in original_filename (AC-42)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "screenshot.png", { type: "image/png" }));

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: form,
      });

      const body = await readJson<TaskEvidence>(res);
      expect(body.original_filename).toBe("screenshot.png");
    });

    it("rejects a file larger than 10 MB with 400 and evidence_file_too_large (AC-44)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
      const form = new FormData();
      form.append("file", new File([oversized], "big.txt", { type: "text/plain" }));

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("evidence_file_too_large");
    });

    it.each([".exe", ".sh", ".app", ".command", ".scpt"])(
      "rejects a disallowed extension %s with 400 and evidence_extension_not_allowed (AC-45)",
      async (ext) => {
        const app = createApp(db, process.env, { evidenceDir });
        const taskId = createTask(db);
        const form = new FormData();
        form.append("file", new File([new Uint8Array([1])], `evil${ext}`, { type: "application/octet-stream" }));

        const res = await app.request(`/api/tasks/${taskId}/evidences`, {
          method: "POST",
          body: form,
        });

        expect(res.status, ext).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.code, ext).toBe("evidence_extension_not_allowed");
      },
    );

    it.each([".svg", ".html"])(
      "rejects active-content extension %s with 400 and evidence_extension_not_allowed (AC-46)",
      async (ext) => {
        const app = createApp(db, process.env, { evidenceDir });
        const taskId = createTask(db);
        const form = new FormData();
        form.append("file", new File([new Uint8Array([1])], `x${ext}`, { type: "text/plain" }));

        const res = await app.request(`/api/tasks/${taskId}/evidences`, {
          method: "POST",
          body: form,
        });

        expect(res.status, ext).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.code, ext).toBe("evidence_extension_not_allowed");
      },
    );

    it("treats extensions case-insensitively — .PNG is allowed (AC-47)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "SCREENSHOT.PNG", { type: "image/png" }));

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(201);
    });

    it("rejects an 11th evidence with 409 and evidence_limit_exceeded (AC-48)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      for (let i = 0; i < 10; i++) {
        insertTaskEvidence(db, { task_id: taskId, kind: "link", url: `https://example.com/${i}` });
      }
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(409);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("evidence_limit_exceeded");
    });

    it("returns 404 for a non-existent task id (AC-52)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));

      const res = await app.request(`/api/tasks/9999/evidences`, {
        method: "POST",
        body: form,
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/tasks/:id/evidences (JSON link)", () => {
    it("returns 201 and kind: link for a valid https url (AC-49)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/pr/1" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<TaskEvidence>(res);
      expect(body.kind).toBe("link");
      expect(body.url).toBe("https://example.com/pr/1");
    });

    it("rejects a file: scheme url with 400 and evidence_url_scheme_not_allowed (AC-50)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "file:///etc/passwd" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("evidence_url_scheme_not_allowed");
    });

    it("rejects a javascript: scheme url with 400 and evidence_url_scheme_not_allowed (AC-51)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);

      const res = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "javascript:alert(1)" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("evidence_url_scheme_not_allowed");
    });

    it("returns 404 for a non-existent task id (AC-52)", async () => {
      const app = createApp(db, process.env, { evidenceDir });

      const res = await app.request(`/api/tasks/9999/evidences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/x" }),
      });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/tasks/:id/evidences/:evidenceId/content", () => {
    it("returns the file body (AC-55)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new TextEncoder().encode("hello")], "note.txt", { type: "text/plain" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
    });

    it("derives Content-Type from the stored extension, not a client-provided value (AC-56)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append(
        "file",
        new File([new Uint8Array([1])], "report.pdf", { type: "application/x-not-real" }),
      );
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.headers.get("Content-Type")).toBe("application/pdf");
    });

    it("includes X-Content-Type-Options: nosniff (AC-57)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("uses Content-Disposition: attachment for a non-image, non-PDF file (AC-58)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.headers.get("Content-Disposition")).toBe("attachment");
    });

    it("uses Content-Disposition: inline for an image", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "photo.png", { type: "image/png" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.headers.get("Content-Disposition")).toBe("inline");
    });

    it("uses Content-Disposition: inline for a pdf", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "report.pdf", { type: "application/pdf" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}/content`);

      expect(res.headers.get("Content-Disposition")).toBe("inline");
    });

    it("returns 404 for a kind: link evidence (AC-59)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const link = insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      const res = await app.request(`/api/tasks/${taskId}/evidences/${link.id}/content`);

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/tasks/:id/evidences/:evidenceId", () => {
    it("removes the DB row (AC-60)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const evidence = insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
      const list = await readJson<TaskEvidence[]>(
        await app.request(`/api/tasks/${taskId}/evidences`),
      );
      expect(list).toEqual([]);
    });

    it("also removes the stored file (AC-61)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);
      const form = new FormData();
      form.append("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const created = await readJson<TaskEvidence>(
        await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: form }),
      );
      const storedPath = join(evidenceDir, created.stored_filename as string);
      expect(existsSync(storedPath)).toBe(true);

      const res = await app.request(`/api/tasks/${taskId}/evidences/${created.id}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
      expect(existsSync(storedPath)).toBe(false);
    });

    it("returns 409 and task_already_done for a done task (AC-62)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db, { status: "done" });
      const evidence = insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(409);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("task_already_done");
    });

    it("leaves the evidence row intact after a 409 (AC-63)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db, { status: "done" });
      const evidence = insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, { method: "DELETE" });

      const list = await readJson<TaskEvidence[]>(
        await app.request(`/api/tasks/${taskId}/evidences`),
      );
      expect(list).toHaveLength(1);
    });

    it("allows deletion after the task is moved back to in_progress (AC-64)", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db, { status: "done" });
      const evidence = insertTaskEvidence(db, { task_id: taskId, kind: "link", url: "https://example.com/x" });

      const blocked = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });
      expect(blocked.status).toBe(409);

      await app.request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(204);
    });

    it("returns 404 for a non-existent evidence id", async () => {
      const app = createApp(db, process.env, { evidenceDir });
      const taskId = createTask(db);

      const res = await app.request(`/api/tasks/${taskId}/evidences/9999`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });
});
