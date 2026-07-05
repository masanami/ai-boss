import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import {
  findLatestEvent,
  listEventsSince,
  recordActivityEvent,
} from "./activity-events-repository.js";

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
