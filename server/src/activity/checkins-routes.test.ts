import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { NewTaskRecord } from "../tasks/tasks-repository.js";
import type { Task, TaskStatus } from "../tasks/task.js";
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

/** Directly inserts an activity_events row, bypassing the route, to seed
 * "existing history" fixtures for the occurred_at integrity-check tests
 * below (backdated task_start/task_pause comparisons, break_start/break_end
 * ordering). */
function insertEvent(
  db: Database.Database,
  type: string,
  createdAt: string,
  taskId: number | null = null,
) {
  db.prepare(
    "INSERT INTO activity_events (type, task_id, created_at) VALUES (?, ?, ?)",
  ).run(type, taskId, createdAt);
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

    it("transitions a paused task to in_progress (AC-5)", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "paused" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_start", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("in_progress");

      const events = db
        .prepare("SELECT type FROM activity_events WHERE task_id = ? ORDER BY id ASC")
        .all(task.id) as { type: string }[];
      expect(events.map((event) => event.type)).toEqual(["task_start", "task_update"]);
    });
  });

  describe("task_pause status transition", () => {
    it("transitions an in_progress task to paused and records a task_pause event", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "in_progress" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause", task_id: task.id }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body).toMatchObject({ type: "task_pause", task_id: task.id });

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("paused");

      // Symmetric with the task_start todo -> in_progress case: the
      // task_pause event (this route) plus updateTask's own automatic
      // task_update event are both expected, in that order.
      const events = db
        .prepare("SELECT type FROM activity_events WHERE task_id = ? ORDER BY id ASC")
        .all(task.id) as { type: string }[];
      expect(events.map((event) => event.type)).toEqual(["task_pause", "task_update"]);
    });

    it("does not record a break_start event as a side effect of task_pause (AC-6)", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "in_progress" });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      // Break events carry task_id = null, so scan ALL events — filtering by
      // task_id would hide exactly the side effect this test exists to catch.
      const events = db
        .prepare("SELECT type FROM activity_events")
        .all() as { type: string }[];
      expect(events.map((event) => event.type)).not.toContain("break_start");
    });

    // Written as individual `it(...)` calls (rather than `it.each`) so each
    // status gets its own literal test name in the reporter output.
    async function expectTaskPauseLeavesStatusUnchanged(status: TaskStatus) {
      const app = createApp(db);
      const task = insertWorkTask(db, { status });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause", task_id: task.id }),
      });

      expect(res.status).toBe(201);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe(status);

      const events = db
        .prepare("SELECT type FROM activity_events WHERE task_id = ?")
        .all(task.id) as { type: string }[];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task_pause");
    }

    it("leaves a todo task's status unchanged and records only the task_pause event (AC-20)", async () => {
      await expectTaskPauseLeavesStatusUnchanged("todo");
    });

    it("leaves a done task's status unchanged and records only the task_pause event (AC-20)", async () => {
      await expectTaskPauseLeavesStatusUnchanged("done");
    });

    it("leaves a dropped task's status unchanged and records only the task_pause event (AC-20)", async () => {
      await expectTaskPauseLeavesStatusUnchanged("dropped");
    });

    it("leaves a paused task's status unchanged and records only the task_pause event (AC-20)", async () => {
      await expectTaskPauseLeavesStatusUnchanged("paused");
    });

    it("returns 400 when task_pause is missing task_id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("task_id");
    });

    it("returns 404 when task_pause references a non-existent task", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause", task_id: 9999 }),
      });

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("9999");
    });

    it("rolls back the task_pause event when the status update fails, leaving no partial write", async () => {
      const app = createApp(db);
      const task = insertWorkTask(db, { status: "in_progress" });
      updateTaskMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "task_pause", task_id: task.id }),
      });

      expect(res.status).toBe(500);

      const events = db
        .prepare("SELECT * FROM activity_events WHERE task_id = ?")
        .all(task.id);
      expect(events).toHaveLength(0);

      const updated = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task.id) as { status: string };
      expect(updated.status).toBe("in_progress");
    });
  });

  describe("occurred_at", () => {
    // Local (not UTC) constructor per ADR 0007 決定5 — pins today at
    // 2026-07-05 14:00 local time so "now" and the local-day boundary
    // checks below stay TZ-independent (npm run test:tz).
    const NOW = new Date(2026, 6, 5, 14, 0, 0, 0);
    const START_OF_TODAY = new Date(2026, 6, 5, 0, 0, 0, 0).toISOString();
    const YESTERDAY_JUST_BEFORE_MIDNIGHT = new Date(
      2026,
      6,
      4,
      23,
      59,
      59,
      999,
    ).toISOString();
    const EARLIER_TODAY = new Date(2026, 6, 5, 9, 0, 0, 0).toISOString();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("stores and returns the normalized created_at for a past occurred_at (AC-1)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: EARLIER_TODAY }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body.created_at).toBe(EARLIER_TODAY);

      const row = db
        .prepare("SELECT created_at FROM activity_events WHERE id = ?")
        .get(body.id) as { created_at: string };
      expect(row.created_at).toBe(EARLIER_TODAY);
    });

    it("normalizes an offset-bearing occurred_at to Z form (AC-1)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "checkin",
          occurred_at: "2026-07-05T14:00:00+09:00",
        }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body.created_at).toBe(new Date("2026-07-05T14:00:00+09:00").toISOString());
    });

    it("records with the server's current time when occurred_at is omitted (AC-2)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body.created_at).toBe(NOW.toISOString());
    });

    it("records with the server's current time when occurred_at is explicitly null (AC-2)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: null }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body.created_at).toBe(NOW.toISOString());
    });

    it("returns 400 when occurred_at is not a valid ISO 8601 date-time (AC-3)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: "2026-07-05" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("occurred_at");
    });

    it("returns 400 when occurred_at is after the current time (AC-4)", async () => {
      const app = createApp(db);
      const future = new Date(NOW.getTime() + 1).toISOString();

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: future }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("future");
    });

    it("accepts occurred_at exactly equal to the current time (AC-4 boundary)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: NOW.toISOString() }),
      });

      expect(res.status).toBe(201);
    });

    it("returns 400 when occurred_at is before the start of today (AC-5)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "checkin",
          occurred_at: YESTERDAY_JUST_BEFORE_MIDNIGHT,
        }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("today");
    });

    it("accepts occurred_at exactly at the start of today (AC-5 boundary)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/checkins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkin", occurred_at: START_OF_TODAY }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<ActivityEvent>(res);
      expect(body.created_at).toBe(START_OF_TODAY);
    });

    describe("break_end ordering (判断5)", () => {
      it("returns 400 when there is no break_start before occurred_at (AC-6)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "break_end",
            occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("break_start");
      });

      it("returns 400 when the prior break_start already has a break_end before occurred_at (AC-7)", async () => {
        const app = createApp(db);
        insertEvent(db, "break_start", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString());
        insertEvent(db, "break_end", new Date(2026, 6, 5, 9, 30, 0, 0).toISOString());

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "break_end",
            occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      });

      it("returns 400 when a break_end already exists at exactly occurred_at (AC-7, duplicate retry)", async () => {
        const app = createApp(db);
        const breakEndAt = new Date(2026, 6, 5, 9, 30, 0, 0).toISOString();
        insertEvent(db, "break_start", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString());
        insertEvent(db, "break_end", breakEndAt);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "break_end", occurred_at: breakEndAt }),
        });

        expect(res.status).toBe(400);
        const rows = db
          .prepare("SELECT id FROM activity_events WHERE type = 'break_end'")
          .all();
        expect(rows).toHaveLength(1);
      });

      it("records a 201 when the prior break_start has no break_end before occurred_at yet, even if a later break is already recorded (AC-8)", async () => {
        const app = createApp(db);
        insertEvent(db, "break_start", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString());
        // A later, already-completed break recorded after occurred_at — must
        // not affect the check (see checkBreakEndOrder's AC-8 comment: the
        // rejected "latest break_start" alternative would wrongly reject
        // this case).
        insertEvent(db, "break_start", new Date(2026, 6, 5, 10, 0, 0, 0).toISOString());
        insertEvent(db, "break_end", new Date(2026, 6, 5, 10, 30, 0, 0).toISOString());

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "break_end",
            occurred_at: new Date(2026, 6, 5, 9, 30, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(201);
        const body = await readJson<ActivityEvent>(res);
        expect(body.created_at).toBe(new Date(2026, 6, 5, 9, 30, 0, 0).toISOString());
      });

      it("returns 400 when occurred_at is exactly equal to the most recent break_start (AC-33)", async () => {
        const app = createApp(db);
        const breakStartAt = new Date(2026, 6, 5, 9, 0, 0, 0).toISOString();
        insertEvent(db, "break_start", breakStartAt);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "break_end", occurred_at: breakStartAt }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("break_start");
      });
    });

    describe("task_start/task_pause transition eligibility (判断4)", () => {
      it("records the event but leaves status unchanged when occurred_at equals the latest task_start exactly (AC-10, 判断4 strict comparison)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "in_progress" });
        const startedAt = new Date(2026, 6, 5, 9, 0, 0, 0).toISOString();
        insertEvent(db, "task_start", startedAt, task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "task_pause", task_id: task.id, occurred_at: startedAt }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("in_progress");
        const events = db
          .prepare("SELECT type FROM activity_events WHERE task_id = ? AND type = 'task_pause'")
          .all(task.id);
        expect(events).toHaveLength(1);
      });

      it("records the event but leaves status unchanged when occurred_at equals the latest task_pause exactly (AC-12, 判断4 strict comparison)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "paused" });
        const pausedAt = new Date(2026, 6, 5, 9, 0, 0, 0).toISOString();
        insertEvent(db, "task_pause", pausedAt, task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "task_start", task_id: task.id, occurred_at: pausedAt }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("paused");
        const events = db
          .prepare("SELECT type FROM activity_events WHERE task_id = ? AND type = 'task_start'")
          .all(task.id);
        expect(events).toHaveLength(1);
      });

      it("transitions in_progress to paused when occurred_at is newer than the latest task_start/task_pause (AC-9)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "in_progress" });
        insertEvent(db, "task_start", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(), task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "task_pause",
            task_id: task.id,
            occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("paused");
      });

      it("records the event but leaves status unchanged when occurred_at is older than the latest task_start/task_pause (AC-10)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "in_progress" });
        insertEvent(db, "task_start", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(), task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "task_pause",
            task_id: task.id,
            occurred_at: new Date(2026, 6, 5, 8, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("in_progress");

        const events = db
          .prepare("SELECT type FROM activity_events WHERE task_id = ? AND type = 'task_pause'")
          .all(task.id);
        expect(events).toHaveLength(1);
      });

      it("transitions paused to in_progress when occurred_at is newer than the latest task_start/task_pause (AC-11)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "paused" });
        insertEvent(db, "task_pause", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(), task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "task_start",
            task_id: task.id,
            occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("in_progress");
      });

      it("records the event but leaves status unchanged when occurred_at is older than the latest task_start/task_pause (AC-12)", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "paused" });
        insertEvent(db, "task_pause", new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(), task.id);

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "task_start",
            task_id: task.id,
            occurred_at: new Date(2026, 6, 5, 8, 0, 0, 0).toISOString(),
          }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("paused");

        const events = db
          .prepare("SELECT type FROM activity_events WHERE task_id = ? AND type = 'task_start'")
          .all(task.id);
        expect(events).toHaveLength(1);
      });

      it("transitions when occurred_at is given but the task has no prior task_start/task_pause event", async () => {
        const app = createApp(db);
        const task = insertWorkTask(db, { status: "todo" });

        const res = await app.request("/api/checkins", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "task_start",
            task_id: task.id,
            occurred_at: EARLIER_TODAY,
          }),
        });

        expect(res.status).toBe(201);
        const updated = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task.id) as { status: string };
        expect(updated.status).toBe("in_progress");
      });
    });
  });
});
