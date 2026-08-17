import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { NewTaskRecord } from "../tasks/tasks-repository.js";
import type { Task } from "../tasks/task.js";
import { isTopTaskUnstarted } from "../detection/unstarted.js";
import { DEFAULT_DETECTION_SETTINGS } from "../detection/detection-types.js";
import type { ActivityEvent } from "./activity-event.js";

// Partial mock: only `updateTask` is overridable (via `mockImplementationOnce`
// in the "rolls back" test below), every other export (`insertTask`,
// `findTaskById`, ...) passes through to the real implementation. This lets
// that one test force `updateTask` to throw and observe whether the
// surrounding `db.transaction(...)` in checkins-routes.ts actually rolls
// back the `task_start` event, without affecting the other tests in this
// file (all of which use the real `updateTask`).
const { updateTaskMock } = vi.hoisted(() => ({ updateTaskMock: vi.fn() }));

vi.mock("../tasks/tasks-repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tasks/tasks-repository.js")>();
  updateTaskMock.mockImplementation(actual.updateTask);
  return { ...actual, updateTask: updateTaskMock };
});

interface ErrorBody {
  error: string;
}

/** Reduces the 8-field `insertTask` boilerplate repeated across the tests below. */
function insertWorkTask(db: Database.Database, overrides: Partial<NewTaskRecord> = {}): Task {
  return insertTask(db, {
    title: "資料作成",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    ...overrides,
  });
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
    const task = insertWorkTask(db);

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

  describe("task_start status transition", () => {
    // No afterEach reset needed here: only the "rolls back" test below uses
    // `mockImplementationOnce`, and it is consumed synchronously by the
    // single `app.request(...)` call inside that same test — it cannot leak
    // into a later test. Every other test in this describe block relies on
    // the pass-through `updateTask` implementation set once by the
    // `vi.mock` factory above.
    it("transitions a todo task to in_progress and keeps completed_at null", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "todo" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body).toMatchObject({ type: "task_start", task_id: task.id });

      const updated = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as { status: string; completed_at: string | null };
      expect(updated.status).toBe("in_progress");
      expect(updated.completed_at).toBeNull();

      // The design explicitly accepts the double event record: `task_start`
      // (this route) plus `updateTask`'s own automatic `task_update` (see
      // #133's design rationale for not bypassing the shared update path).
      const events = db
        .prepare("SELECT type FROM activity_events WHERE task_id = ? ORDER BY id ASC")
        .all(task.id) as { type: string }[];
      expect(events.map((event) => event.type)).toEqual(["task_start", "task_update"]);
    });

    it("leaves status unchanged and records no extra task_update event for an in_progress task", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "in_progress" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("in_progress");

      const events = db
        .prepare("SELECT * FROM activity_events WHERE task_id = ?")
        .all(task.id) as { type: string }[];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task_start");
    });

    it("does not revert a done task's status or completed_at", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "done" });
      const before = db
        .prepare("SELECT completed_at FROM tasks WHERE id = ?")
        .get(task.id) as { completed_at: string | null };

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT status, completed_at FROM tasks WHERE id = ?")
        .get(task.id) as { status: string; completed_at: string | null };
      expect(updated.status).toBe("done");
      expect(updated.completed_at).toBe(before.completed_at);
    });

    it("does not revert a dropped task's status", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "dropped" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("dropped");
    });

    it("does not change task status for non-task_start checkin types", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "todo" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("todo");
    });

    it("transitioning a task to in_progress excludes it from unstarted detection", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "todo", estimated_minutes: 30 });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });
      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task.id) as Task;
      // Well past any unstarted threshold; only status = in_progress (not
      // elapsed time) is what should exclude it (see unstarted.ts).
      const farFuture = new Date(
        new Date(updated.created_at).getTime() + 10 * 60 * 60 * 1000,
      );
      expect(
        isTopTaskUnstarted(updated, farFuture, DEFAULT_DETECTION_SETTINGS.unstarted),
      ).toBe(false);
      // Control: the same elapsed time *does* fire when status is still
      // todo, proving the assertion above exercises the status transition
      // (not just always-false threshold math).
      expect(
        isTopTaskUnstarted(
          { ...updated, status: "todo" },
          farFuture,
          DEFAULT_DETECTION_SETTINGS.unstarted,
        ),
      ).toBe(true);
    });

    it("rolls back the task_start event when the status update fails, leaving no partial write", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "todo" });
      updateTaskMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      // Hono's default error handling turns the thrown error into a 500;
      // what this test actually pins down is that db.transaction(...) in
      // checkins-routes.ts rolled back the task_start insert alongside the
      // failed status update (no half-applied state), not the exact status
      // code contract for this failure mode.
      expect(res.status).toBe(500);

      const events = db
        .prepare("SELECT * FROM activity_events WHERE task_id = ?")
        .all(task.id);
      expect(events).toHaveLength(0);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("todo");
    });
  });
});
