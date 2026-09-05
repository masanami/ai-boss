import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import type { Task } from "./task.js";

interface ErrorBody {
  error: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("tasks routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  describe("GET /api/tasks", () => {
    it("returns an empty array when no tasks exist", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks");

      expect(res.status).toBe(200);
      expect(await readJson<Task[]>(res)).toEqual([]);
    });

    it("returns all tasks ordered by created_at ascending", async () => {
      const app = createApp(db);

      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "1つ目" }),
      });
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "2つ目" }),
      });

      const res = await app.request("/api/tasks");

      expect(res.status).toBe(200);
      const body = await readJson<Task[]>(res);
      expect(body.map((t) => t.title)).toEqual(["1つ目", "2つ目"]);
    });
  });

  describe("POST /api/tasks", () => {
    it("creates a task with only a title, filling in defaults", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "牛乳を買う" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        title: "牛乳を買う",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
        completed_at: null,
      });
      expect(typeof body.id).toBe("number");
      expect(typeof body.created_at).toBe("string");
      expect(typeof body.updated_at).toBe("string");
    });

    it("creates a task with all optional fields set", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "資料を作る",
          description: "月次報告資料",
          category: "work",
          priority: "high",
          due_at: "2026-07-10T09:00:00.000Z",
          status: "in_progress",
          boss_comment: "先にこれをやれ",
          estimated_minutes: 90,
        }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        title: "資料を作る",
        description: "月次報告資料",
        category: "work",
        priority: "high",
        due_at: "2026-07-10T09:00:00.000Z",
        status: "in_progress",
        boss_comment: "先にこれをやれ",
        estimated_minutes: 90,
      });
    });

    it("returns 400 with a machine-readable error when title is missing", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when title is an empty string", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when status is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", status: "not-a-status" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when priority is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", priority: "urgent" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when estimated_minutes is not a non-negative integer", async () => {
      const app = createApp(db);

      for (const invalid of ["abc", -5, 1.5]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", estimated_minutes: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("returns 400 when description is not a string", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", description: 123 }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when boss_comment is not a string or null", async () => {
      const app = createApp(db);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", boss_comment: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("returns 400 when due_at is not a string or null", async () => {
      const app = createApp(db);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    // due_at の**形式**不正（#199 / GAP-34）。型が string でも暦として解釈
    // できない値を通すと、`detection/deadline-overdue.ts` が
    // `new Date(due_at).getTime()` を NaN にして期限超過を永久に検知せず、
    // `detection/priority.ts` の並び順にも NaN が混入する。
    it("returns 400 when due_at is a string that is not a valid ISO 8601 date or date-time", async () => {
      const app = createApp(db);

      for (const invalid of [
        "not-a-date-at-all",
        "0",
        "2026",
        "12/31/2026",
        "2026-02-30",
        "2026-13-01",
        "2026-09-05T24:00",
      ]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: invalid }),
        });

        expect(res.status, invalid).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("accepts the due_at shapes the web date input and the boss tool actually produce", async () => {
      const app = createApp(db);

      for (const valid of [
        "2026-09-05",
        "2026-09-05T09:30",
        "2026-09-05T09:30:00.000Z",
        "2026-09-05T09:30:00+09:00",
      ]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: valid }),
        });

        expect(res.status, valid).toBe(201);
        const body = await readJson<{ due_at: string | null }>(res);
        expect(body.due_at).toBe(valid);
      }
    });

    it("sets completed_at when a task is created directly with status done", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "完了済みで登録", status: "done" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("done");
      expect(typeof body.completed_at).toBe("string");
    });

    it("returns 400 when the request body is not valid JSON", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });
  });

  describe("PATCH /api/tasks/:id", () => {
    it("returns 404 for a non-existent id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks/9999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新" }),
      });

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 404 for a non-numeric id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks/not-a-number", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新" }),
      });

      expect(res.status).toBe(404);
    });

    // POST 側と同じ形式検証が PATCH 経路にも効くこと（両経路とも
    // `validateOptionalFieldTypes` を通るが、片方だけ結線される回帰を防ぐ）。
    it("returns 400 when due_at is patched to a string that is not a valid ISO 8601 date or date-time", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      for (const invalid of ["not-a-date-at-all", "2026-02-30", "2026"]) {
        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ due_at: invalid }),
        });

        expect(res.status, invalid).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }

      const after = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_at: "2026-09-05" }),
      });
      expect(after.status).toBe(200);
      expect((await readJson<Task>(after)).due_at).toBe("2026-09-05");
    });

    it("partially updates only the specified fields, keeping the rest", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク", description: "元の詳細" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        id: created.id,
        title: "元のタスク",
        description: "元の詳細",
        priority: "high",
      });
    });

    it("updates updated_at when a task is patched", async () => {
      const app = createApp(db);
      // created_at と updated_at が同一ミリ秒だと「値が進む」が成立せず
      // 環境依存でフレークするため、作成時刻と PATCH 時刻を明示的にずらす
      // (ローカル日付基準・TZ非依存。UTC文字列リテラルの直書きは禁止)
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 1, 9, 0));

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      vi.setSystemTime(new Date(2026, 5, 1, 9, 5));

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新後" }),
      });

      const body = await readJson<Task>(res);
      expect(typeof body.updated_at).toBe("string");
      expect(body.updated_at).not.toBe("");
      expect(new Date(body.updated_at).getTime()).toBeGreaterThan(
        new Date(created.updated_at).getTime(),
      );
      expect(created.created_at).toBe(body.created_at);
    });

    it("returns 400 when status is invalid", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when priority is invalid", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "urgent" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when boss_comment is patched to a non-string, non-null value", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_comment: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("updates boss_comment when patched with a valid string (guards against an always-400 implementation)", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_comment: "先にこれをやれ" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.boss_comment).toBe("先にこれをやれ");
    });

    it("returns 400 when title is patched to an empty string", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when category is included in the patch", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "hobby" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("category");
    });

    it("sets completed_at when status transitions to done", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);
      expect(created.completed_at).toBeNull();

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("done");
      expect(typeof body.completed_at).toBe("string");
    });

    it("clears completed_at when status transitions away from done", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("in_progress");
      expect(body.completed_at).toBeNull();
    });
  });
});
