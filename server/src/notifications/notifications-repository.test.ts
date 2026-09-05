import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  findLatestNotificationByRuleKey,
  insertNotification,
  listNotificationsBetween,
  listNotificationsSince,
  recordNotificationDelivery,
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

  // #321: the record is written *before* the send (Issue #221), so at insert
  // time the delivery outcome is genuinely unknown — not "failed".
  it("leaves the delivery outcome unknown (delivered/channel null) at insert time (#321)", () => {
    const notification = insertNotification(db, {
      type: "escalation",
      rule_key: "silence",
      escalation_level: 1,
      body: "今何をやっている？",
    });

    expect(notification).toMatchObject({ delivered: null, channel: null });
  });
});

describe("recordNotificationDelivery", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    [{ delivered: true, channel: "terminal-notifier" }, { delivered: 1, channel: "terminal-notifier" }],
    [{ delivered: true, channel: "osascript" }, { delivered: 1, channel: "osascript" }],
    [{ delivered: false, channel: "none" }, { delivered: 0, channel: "none" }],
  ] as const)(
    "records the send result %j on the notification row as %j (#321)",
    (result, expected) => {
      const notification = insertNotification(db, {
        type: "escalation",
        rule_key: "silence",
        escalation_level: 1,
        body: "L1",
      });

      recordNotificationDelivery(db, notification.id, result);

      const row = db
        .prepare("SELECT delivered, channel FROM notifications WHERE id = ?")
        .get(notification.id);
      expect(row).toEqual(expected);
    },
  );

  it("only updates the targeted row", () => {
    const first = insertNotification(db, { type: "escalation", rule_key: "silence", escalation_level: 1, body: "L1" });
    const second = insertNotification(db, { type: "escalation", rule_key: "silence", escalation_level: 2, body: "L2" });

    recordNotificationDelivery(db, second.id, { delivered: false, channel: "none" });

    expect(findLatestNotificationByRuleKey(db, "silence")).toMatchObject({
      id: second.id,
      delivered: 0,
      channel: "none",
    });
    const untouched = db
      .prepare("SELECT delivered, channel FROM notifications WHERE id = ?")
      .get(first.id);
    expect(untouched).toEqual({ delivered: null, channel: null });
  });

  it("throws when no notification has the given id, instead of silently updating nothing", () => {
    expect(() =>
      recordNotificationDelivery(db, 9999, { delivered: true, channel: "terminal-notifier" }),
    ).toThrow(/9999/);
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

describe("listNotificationsBetween", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertAt(body: string, sentAt: string): number {
    const result = db
      .prepare(
        "INSERT INTO notifications (type, rule_key, escalation_level, body, sent_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("escalation", "silence", 1, body, sentAt);
    return Number(result.lastInsertRowid);
  }

  it("returns notifications in the half-open window [since, until): includes the lower bound exactly, excludes the upper bound exactly, oldest first (ADR 0007 決定3, #236)", () => {
    // 経過時間のみを扱うため UTC リテラルでよい（ADR 0007 決定5）。
    const since = "2026-07-05T09:00:00.000Z";
    const until = "2026-07-05T12:00:00.000Z";

    insertAt("対象外（since より前）", "2026-07-05T08:59:59.999Z");
    const atSinceId = insertAt("対象内（ちょうど since）", since);
    const insideId = insertAt("対象内（中間）", "2026-07-05T10:00:00.000Z");
    const justBeforeUntilId = insertAt("対象内（until の直前）", "2026-07-05T11:59:59.999Z");
    insertAt("対象外（ちょうど until）", until);
    insertAt("対象外（until より後）", "2026-07-05T12:00:00.001Z");

    const results = listNotificationsBetween(db, since, until);

    expect(results.map((n) => n.id)).toEqual([atSinceId, insideId, justBeforeUntilId]);
  });
});
