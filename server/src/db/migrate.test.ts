import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrate.js";

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return rows.map((row) => row.name);
}

const NOW = "2026-07-05T00:00:00.000Z";

function insertSession(db: Database.Database, type = "adhoc"): number {
  return Number(
    db
      .prepare("INSERT INTO sessions (type, started_at) VALUES (?, ?)")
      .run(type, NOW).lastInsertRowid,
  );
}

function insertDecision(db: Database.Database, sessionId: number): number {
  return Number(
    db
      .prepare(
        "INSERT INTO decisions (session_id, content, created_at) VALUES (?, ?, ?)",
      )
      .run(sessionId, "決定内容", NOW).lastInsertRowid,
  );
}

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates the tasks table", () => {
    expect(tableNames(db)).toContain("tasks");
  });

  it("creates the sessions table", () => {
    expect(tableNames(db)).toContain("sessions");
  });

  it("creates the messages table", () => {
    expect(tableNames(db)).toContain("messages");
  });

  it("creates the decisions table", () => {
    expect(tableNames(db)).toContain("decisions");
  });

  it("creates the appeals table", () => {
    expect(tableNames(db)).toContain("appeals");
  });

  it("creates the settings table", () => {
    expect(tableNames(db)).toContain("settings");
  });

  it("creates the notifications table", () => {
    expect(tableNames(db)).toContain("notifications");
  });

  it("creates the activity_events table", () => {
    expect(tableNames(db)).toContain("activity_events");
  });

  it("gives tasks a nullable estimated_minutes column", () => {
    expect(columnNames(db, "tasks")).toContain("estimated_minutes");
  });

  it("gives notifications rule_key and escalation_level columns", () => {
    const columns = columnNames(db, "notifications");
    expect(columns).toContain("rule_key");
    expect(columns).toContain("escalation_level");
  });

  it("defaults tasks.category to 'work' when not specified", () => {
    db.prepare(
      "INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)",
    ).run("資料作成", NOW, NOW);

    const row = db.prepare("SELECT category FROM tasks").get() as {
      category: string;
    };

    expect(row.category).toBe("work");
  });

  it("is idempotent: running migrations twice does not raise an error", () => {
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db).sort()).toEqual(
      [
        "tasks",
        "sessions",
        "messages",
        "decisions",
        "appeals",
        "settings",
        "notifications",
        "activity_events",
        "sqlite_sequence",
      ].sort(),
    );
  });

  it("enforces foreign keys: inserting a message with an unknown session_id fails", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(9999, "user", "hello", NOW),
    ).toThrow();
  });

  describe("CHECK constraints", () => {
    it.each([["todo"], ["in_progress"], ["done"], ["dropped"]])(
      "accepts tasks.status = %s",
      (status) => {
        expect(() =>
          db
            .prepare(
              "INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("タスク", status, NOW, NOW),
        ).not.toThrow();
      },
    );

    it("rejects an invalid tasks.status", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run("タスク", "invalid", NOW, NOW),
      ).toThrow();
    });

    it.each([["morning"], ["evening"], ["adhoc"]])(
      "accepts sessions.type = %s",
      (type) => {
        expect(() => insertSession(db, type)).not.toThrow();
      },
    );

    it("rejects an invalid sessions.type", () => {
      expect(() => insertSession(db, "invalid")).toThrow();
    });

    it.each([["user"], ["boss"]])("accepts messages.role = %s", (role) => {
      const sessionId = insertSession(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, role, "hello", NOW),
      ).not.toThrow();
    });

    it("rejects an invalid messages.role", () => {
      const sessionId = insertSession(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, "invalid", "hello", NOW),
      ).toThrow();
    });

    it.each([["active"], ["revised"], ["withdrawn"]])(
      "accepts decisions.status = %s",
      (status) => {
        const sessionId = insertSession(db);

        expect(() =>
          db
            .prepare(
              "INSERT INTO decisions (session_id, content, status, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionId, "決定内容", status, NOW),
        ).not.toThrow();
      },
    );

    it("rejects an invalid decisions.status", () => {
      const sessionId = insertSession(db);

      expect(() =>
        db
          .prepare(
            "INSERT INTO decisions (session_id, content, status, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(sessionId, "決定内容", "invalid", NOW),
      ).toThrow();
    });

    it.each([["upheld"], ["revised"]])(
      "accepts appeals.verdict = %s",
      (verdict) => {
        const decisionId = insertDecision(db, insertSession(db));

        expect(() =>
          db
            .prepare(
              "INSERT INTO appeals (decision_id, content, verdict, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(decisionId, "進言内容", verdict, NOW),
        ).not.toThrow();
      },
    );

    it("rejects an invalid appeals.verdict", () => {
      const decisionId = insertDecision(db, insertSession(db));

      expect(() =>
        db
          .prepare(
            "INSERT INTO appeals (decision_id, content, verdict, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(decisionId, "進言内容", "invalid", NOW),
      ).toThrow();
    });

    it.each([
      ["task_start"],
      ["break_start"],
      ["break_end"],
      ["checkin"],
      ["chat_message"],
      ["task_update"],
    ])("accepts activity_events.type = %s", (type) => {
      expect(() =>
        db
          .prepare("INSERT INTO activity_events (type, created_at) VALUES (?, ?)")
          .run(type, NOW),
      ).not.toThrow();
    });

    it("rejects an invalid activity_events.type", () => {
      expect(() =>
        db
          .prepare("INSERT INTO activity_events (type, created_at) VALUES (?, ?)")
          .run("invalid", NOW),
      ).toThrow();
    });
  });
});
