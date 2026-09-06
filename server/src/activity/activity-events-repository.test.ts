import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import {
  checkBreakEndOrder,
  findLatestEvent,
  findLatestTaskStartOrPauseEvent,
  listEventsSince,
  recordActivityEvent,
} from "./activity-events-repository.js";

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

describe("recordActivityEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records a chat_message event with only a type, defaulting optional fields to null", () => {
    const event = recordActivityEvent(db, { type: "chat_message" });

    expect(event).toMatchObject({
      type: "chat_message",
      task_id: null,
      note: null,
      expected_minutes: null,
    });
    expect(typeof event.id).toBe("number");
    expect(typeof event.created_at).toBe("string");
  });

  it("records an event with task_id, note, and expected_minutes set", () => {
    const event = recordActivityEvent(db, {
      type: "break_start",
      note: "休憩します",
      expected_minutes: 15,
    });

    expect(event).toMatchObject({
      type: "break_start",
      task_id: null,
      note: "休憩します",
      expected_minutes: 15,
    });
  });

  it("persists the event so it can be read back from the database", () => {
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

    const event = recordActivityEvent(db, {
      type: "task_update",
      task_id: task.id,
    });

    const row = db
      .prepare("SELECT * FROM activity_events WHERE id = ?")
      .get(event.id);
    expect(row).toMatchObject({ type: "task_update", task_id: task.id });
  });

  it("uses the given created_at instead of the current time when provided (backdated checkin)", () => {
    const backdated = "2026-07-05T09:00:00.000Z";

    const event = recordActivityEvent(db, {
      type: "task_pause",
      created_at: backdated,
    });

    expect(event.created_at).toBe(backdated);
    const row = db
      .prepare("SELECT created_at FROM activity_events WHERE id = ?")
      .get(event.id) as { created_at: string };
    expect(row.created_at).toBe(backdated);
  });
});

describe("findLatestTaskStartOrPauseEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when the task has no task_start/task_pause events", () => {
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

    expect(findLatestTaskStartOrPauseEvent(db, task.id)).toBeUndefined();
  });

  it("returns the most recent task_start/task_pause event by created_at", () => {
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
    insertEvent(db, "task_start", "2026-07-05T09:00:00.000Z", task.id);
    insertEvent(db, "task_pause", "2026-07-05T11:00:00.000Z", task.id);
    insertEvent(db, "task_start", "2026-07-05T10:00:00.000Z", task.id);

    const latest = findLatestTaskStartOrPauseEvent(db, task.id);

    expect(latest).toMatchObject({
      type: "task_pause",
      created_at: "2026-07-05T11:00:00.000Z",
    });
  });

  it("excludes task_update events from the comparison", () => {
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
    insertEvent(db, "task_start", "2026-07-05T09:00:00.000Z", task.id);
    insertEvent(db, "task_update", "2026-07-05T12:00:00.000Z", task.id);

    const latest = findLatestTaskStartOrPauseEvent(db, task.id);

    expect(latest).toMatchObject({
      type: "task_start",
      created_at: "2026-07-05T09:00:00.000Z",
    });
  });

  it("excludes events belonging to a different task", () => {
    const taskA = insertTask(db, {
      title: "タスクA",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    const taskB = insertTask(db, {
      title: "タスクB",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });
    insertEvent(db, "task_start", "2026-07-05T09:00:00.000Z", taskB.id);

    expect(findLatestTaskStartOrPauseEvent(db, taskA.id)).toBeUndefined();
  });
});

describe("checkBreakEndOrder", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("is invalid when there is no break_start before occurredAt", () => {
    const result = checkBreakEndOrder(db, "2026-07-05T10:00:00.000Z");

    expect(result).toEqual({ valid: false, reason: "no_prior_break_start" });
  });

  it("is invalid when occurredAt is exactly equal to a break_start", () => {
    insertEvent(db, "break_start", "2026-07-05T09:00:00.000Z");

    const result = checkBreakEndOrder(db, "2026-07-05T09:00:00.000Z");

    expect(result).toEqual({ valid: false, reason: "same_as_break_start" });
  });

  it("is invalid when a break_end already exists between the prior break_start and occurredAt", () => {
    insertEvent(db, "break_start", "2026-07-05T09:00:00.000Z");
    insertEvent(db, "break_end", "2026-07-05T09:30:00.000Z");

    const result = checkBreakEndOrder(db, "2026-07-05T10:00:00.000Z");

    expect(result).toEqual({ valid: false, reason: "already_closed" });
  });

  it("is valid when the prior break_start has no break_end before occurredAt yet", () => {
    insertEvent(db, "break_start", "2026-07-05T09:00:00.000Z");

    const result = checkBreakEndOrder(db, "2026-07-05T09:30:00.000Z");

    expect(result).toEqual({ valid: true });
  });

  it("is valid even when a later, already-completed break has been recorded (AC-8)", () => {
    insertEvent(db, "break_start", "2026-07-05T09:00:00.000Z");
    // A later break, already recorded, should not affect the check against
    // the prior break_start for occurredAt = 09:30 (the rejected alternative
    // design of comparing against the *latest* break_start would have wrongly
    // failed this case).
    insertEvent(db, "break_start", "2026-07-05T10:00:00.000Z");
    insertEvent(db, "break_end", "2026-07-05T10:30:00.000Z");

    const result = checkBreakEndOrder(db, "2026-07-05T09:30:00.000Z");

    expect(result).toEqual({ valid: true });
  });
});

describe("listEventsSince", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns only events created at or after the given time, ordered by created_at ascending", () => {
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", "2026-07-05T09:00:00.000Z");
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", "2026-07-05T10:00:00.000Z");
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", "2026-07-05T11:00:00.000Z");

    const events = listEventsSince(db, "2026-07-05T10:00:00.000Z");

    expect(events.map((e) => e.created_at)).toEqual([
      "2026-07-05T10:00:00.000Z",
      "2026-07-05T11:00:00.000Z",
    ]);
  });

  it("returns an empty array when no events are at or after the given time", () => {
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", "2026-07-05T09:00:00.000Z");

    const events = listEventsSince(db, "2026-07-05T10:00:00.000Z");

    expect(events).toEqual([]);
  });

  it("excludes a record exactly at the exclusive upper bound when one is given", () => {
    const lowerBound = new Date(2026, 6, 5, 0, 0, 0, 0).toISOString();
    const justBeforeUpperBound = new Date(2026, 6, 5, 9, 0, 0, 0).toISOString();
    const upperBound = new Date(2026, 6, 6, 0, 0, 0, 0).toISOString();

    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", justBeforeUpperBound);
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", upperBound);

    const events = listEventsSince(db, lowerBound, upperBound);

    expect(events.map((e) => e.created_at)).toEqual([justBeforeUpperBound]);
  });
});

describe("findLatestEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when there are no events", () => {
    expect(findLatestEvent(db)).toBeUndefined();
  });

  it("returns the most recently created event", () => {
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("checkin", "2026-07-05T09:00:00.000Z");
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("break_start", "2026-07-05T11:00:00.000Z");
    db.prepare(
      "INSERT INTO activity_events (type, created_at) VALUES (?, ?)",
    ).run("break_end", "2026-07-05T10:00:00.000Z");

    const latest = findLatestEvent(db);

    expect(latest).toMatchObject({ type: "break_start" });
  });
});
