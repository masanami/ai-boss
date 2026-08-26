import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { ActivityEvent } from "./activity-event.js";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("activity routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /api/activity/today", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns an empty array when there are no events today", async () => {
      const app = createApp(db);

      const res = await app.request("/api/activity/today");

      expect(res.status).toBe(200);
      expect(await readJson<ActivityEvent[]>(res)).toEqual([]);
    });

    it("returns only today's events (local day boundary), ordered by created_at ascending", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 5, 15, 30, 0));

      const insertAt = (isoDate: Date, type: string) => {
        db.prepare(
          "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
        ).run(type, isoDate.toISOString());
      };

      // yesterday, just before midnight — excluded
      insertAt(new Date(2026, 6, 4, 23, 59, 59, 999), "checkin");
      // today, exactly at midnight — included (inclusive boundary)
      insertAt(new Date(2026, 6, 5, 0, 0, 0, 0), "checkin");
      // today, later — included
      insertAt(new Date(2026, 6, 5, 10, 0, 0, 0), "break_start");

      const app = createApp(db);
      const res = await app.request("/api/activity/today");

      expect(res.status).toBe(200);
      const body = await readJson<ActivityEvent[]>(res);
      expect(body.map((e) => e.type)).toEqual(["checkin", "break_start"]);
    });

    it("excludes an event exactly at next-day local midnight (exclusive upper bound)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 5, 15, 30, 0));

      const insertAt = (isoDate: Date, type: string) => {
        db.prepare(
          "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
        ).run(type, isoDate.toISOString());
      };

      // today, later — included
      insertAt(new Date(2026, 6, 5, 10, 0, 0, 0), "checkin");
      // tomorrow, exactly at midnight — excluded (exclusive upper bound)
      insertAt(new Date(2026, 6, 6, 0, 0, 0, 0), "break_start");

      const app = createApp(db);
      const res = await app.request("/api/activity/today");

      expect(res.status).toBe(200);
      const body = await readJson<ActivityEvent[]>(res);
      expect(body.map((e) => e.type)).toEqual(["checkin"]);
    });
  });

  describe("task_update auto-recording", () => {
    it("records a task_update event when PATCH /api/tasks/:id succeeds", async () => {
      const app = createApp(db);
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

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      });
      expect(res.status).toBe(200);

      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "task_update", task_id: task.id });
    });

    it("does not record a task_update event when PATCH /api/tasks/:id fails (404)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks/9999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      });
      expect(res.status).toBe(404);

      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(events).toHaveLength(0);
    });

    it("does not record a task_update event when the PATCH body has no fields (no real change requested)", async () => {
      const app = createApp(db);
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

      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      const events = db
        .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
        .all() as ActivityEvent[];
      expect(events).toHaveLength(0);
    });
  });
});
