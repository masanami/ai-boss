import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  findLatestNotificationByRuleKey,
  insertNotification,
  listNotificationsSince,
} from "./notifications-repository.js";

describe("insertNotification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records a notification with a server-managed sent_at and returns the persisted row", () => {
    const notification = insertNotification(db, {
      type: "escalation",
      rule_key: "silence",
      escalation_level: 1,
      body: "今何をやっている？",
    });

    expect(notification).toMatchObject({
      type: "escalation",
      rule_key: "silence",
      escalation_level: 1,
      body: "今何をやっている？",
    });
    expect(typeof notification.id).toBe("number");
    expect(typeof notification.sent_at).toBe("string");
  });

  it("allows rule_key and escalation_level to be omitted (defaulting to null)", () => {
    const notification = insertNotification(db, {
      type: "session_reminder",
      body: "朝会の時間だ",
    });

    expect(notification).toMatchObject({
      rule_key: null,
      escalation_level: null,
    });
  });

  it("persists the notification so it can be read back from the database", () => {
    const notification = insertNotification(db, {
      type: "escalation",
      rule_key: "todo_stall:1",
      escalation_level: 2,
      body: "早く着手しろ",
    });

    const row = db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(notification.id);
    expect(row).toMatchObject({ type: "escalation", escalation_level: 2 });
  });
});

describe("findLatestNotificationByRuleKey", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when no notification exists for the rule_key", () => {
    expect(findLatestNotificationByRuleKey(db, "silence")).toBeUndefined();
  });

  it("returns the most recently sent notification for the given rule_key", () => {
    insertNotification(db, {
      type: "escalation",
      rule_key: "silence",
      escalation_level: 1,
      body: "L1",
    });
    const latest = insertNotification(db, {
      type: "escalation",
      rule_key: "silence",
      escalation_level: 2,
      body: "L2",
    });
    insertNotification(db, {
      type: "escalation",
      rule_key: "todo_stall:1",
      escalation_level: 1,
      body: "別ルール",
    });

    const found = findLatestNotificationByRuleKey(db, "silence");
    expect(found).toMatchObject({ id: latest.id, escalation_level: 2 });
  });
});

describe("listNotificationsSince", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns only notifications sent at or after the given cutoff, oldest first", () => {
    const cutoff = new Date("2026-07-05T09:00:00.000Z");

    function insertAt(body: string, sentAt: string): number {
      const result = db
        .prepare(
          "INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("escalation", "silence", 1, body, sentAt);
      return Number(result.lastInsertRowid);
    }

    insertAt("対象外（cutoff より前）", "2026-07-05T08:00:00.000Z");
    const atCutoffId = insertAt("対象内（ちょうど cutoff）", cutoff.toISOString());
    const afterCutoffId = insertAt(
      "対象内（cutoff より後）",
      "2026-07-05T10:00:00.000Z",
    );

    const results = listNotificationsSince(db, cutoff.toISOString());

    expect(results.map((n) => n.body)).not.toContain("対象外（cutoff より前）");
    expect(results.map((n) => n.id)).toEqual([atCutoffId, afterCutoffId]);
  });
});
