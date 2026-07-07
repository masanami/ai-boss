import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertNotification } from "../notifications/notifications-repository.js";
import { calculateTodayMaxEscalationLevel } from "./today-escalation.js";

describe("calculateTodayMaxEscalationLevel", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 when there are no notifications", () => {
    const now = new Date(2026, 6, 6, 10, 0);

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(0);
  });

  it("returns the highest escalation_level among today's notifications", () => {
    const now = new Date(2026, 6, 6, 15, 0);
    insertNotification(db, { type: "todo_stall", escalation_level: 1, body: "着手しろ" });
    insertNotification(db, { type: "avoidance", escalation_level: 3, body: "戻れ" });
    insertNotification(db, { type: "silence", escalation_level: 2, body: "報告しろ" });

    expect(calculateTodayMaxEscalationLevel(db, now)).toBe(3);
  });

  it("ignores notifications sent on a previous local day", () => {
    const yesterday = new Date(2026, 6, 5, 23, 0);
    const today = new Date(2026, 6, 6, 9, 0);
    db
      .prepare(
        `INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("todo_stall", null, 3, "昨日の通知", yesterday.toISOString());

    expect(calculateTodayMaxEscalationLevel(db, today)).toBe(0);
  });
});
