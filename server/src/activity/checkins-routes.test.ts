import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { ActivityEvent } from "./activity-event.js";

interface ErrorBody {
  error: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("POST /api/checkins", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records a checkin with only a type and returns 201 with the created event", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkin" }),
    });

    expect(res.status).toBe(201);
    const body = await readJson<ActivityEvent>(res);
    expect(body).toMatchObject({
      type: "checkin",
      task_id: null,
      note: null,
      expected_minutes: null,
    });
    expect(typeof body.id).toBe("number");
    expect(typeof body.created_at).toBe("string");

    const row = db
      .prepare("SELECT * FROM activity_events WHERE id = ?")
      .get(body.id);
    expect(row).toMatchObject({ type: "checkin" });
  });

  it("records break_end with only a type", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "break_end" }),
    });

    expect(res.status).toBe(201);
    const body = await readJson<ActivityEvent>(res);
    expect(body.type).toBe("break_end");
  });

  it("records task_start with a valid task_id", async () => {
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

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "task_start", task_id: task.id }),
    });

    expect(res.status).toBe(201);
    const body = await readJson<ActivityEvent>(res);
    expect(body).toMatchObject({ type: "task_start", task_id: task.id });
  });

  it("records break_start with a note and expected_minutes", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "break_start",
        note: "休憩します",
        expected_minutes: 15,
      }),
    });

    expect(res.status).toBe(201);
    const body = await readJson<ActivityEvent>(res);
    expect(body).toMatchObject({
      type: "break_start",
      note: "休憩します",
      expected_minutes: 15,
    });
  });

  it("returns 400 when type is missing", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when type is not an allowed checkin type", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "task_update" }),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when task_start is missing task_id", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "task_start" }),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toContain("task_id");
  });

  it("returns 404 when task_start references a non-existent task", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "task_start", task_id: 9999 }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toContain("9999");
  });

  it("returns 400 when expected_minutes is not a positive integer", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "break_start", expected_minutes: 0 }),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toContain("expected_minutes");
  });

  it("returns 400 when the request body is not valid JSON", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
  });

  it("returns 404 (not a 500) when a non-task_start checkin references a non-existent task_id", async () => {
    const app = createApp(db);

    const res = await app.request("/api/checkins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkin", task_id: 9999 }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toContain("9999");
  });
});
