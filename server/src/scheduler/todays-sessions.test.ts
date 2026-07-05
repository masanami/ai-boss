import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { listTodaysSessionTypes } from "./todays-sessions.js";

function insertSessionAt(db: Database.Database, type: "morning" | "evening" | "adhoc", startedAt: string): void {
  const session = insertSession(db, { type });
  db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?").run(startedAt, session.id);
}

describe("listTodaysSessionTypes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when no sessions have been started today", () => {
    insertSessionAt(db, "morning", "2026-07-04T09:00:00");

    const result = listTodaysSessionTypes(db, new Date("2026-07-05T12:00:00"));

    expect(result).toEqual([]);
  });

  it("includes session types started today, excluding other days", () => {
    insertSessionAt(db, "morning", "2026-07-05T09:00:00");
    insertSessionAt(db, "evening", "2026-07-04T18:00:00");

    const result = listTodaysSessionTypes(db, new Date("2026-07-05T12:00:00"));

    expect(result).toEqual(["morning"]);
  });

  it("de-duplicates repeated session types on the same day", () => {
    insertSessionAt(db, "adhoc", "2026-07-05T09:00:00");
    insertSessionAt(db, "adhoc", "2026-07-05T10:00:00");

    const result = listTodaysSessionTypes(db, new Date("2026-07-05T12:00:00"));

    expect(result).toEqual(["adhoc"]);
  });
});
