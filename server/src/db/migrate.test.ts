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

// Self-contained snapshot of the v1+v2 schema (duplicated from
// `MIGRATIONS[1]`/`MIGRATIONS[2]` in migrate.ts), used only to simulate a
// pre-existing v2 database for the "upgrades a v2 database to v3" test below.
// Intentionally not imported from migrate.ts: a v2 database's schema must
// stay fixed regardless of future edits to the *current* MIGRATIONS map.
const V1_AND_V2_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'work',
    priority TEXT,
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'todo'
      CHECK (status IN ('todo', 'in_progress', 'done', 'dropped')),
    boss_comment TEXT,
    estimated_minutes INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('morning', 'evening', 'adhoc')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    summary TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'boss')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    task_id INTEGER REFERENCES tasks(id),
    content TEXT NOT NULL,
    rationale TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'revised', 'withdrawn')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id INTEGER NOT NULL REFERENCES decisions(id),
    content TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('upheld', 'revised')),
    created_at TEXT NOT NULL,
    response TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    rule_key TEXT,
    escalation_level INTEGER,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL
      CHECK (type IN (
        'task_start', 'break_start', 'break_end',
        'checkin', 'chat_message', 'task_update'
      )),
    task_id INTEGER REFERENCES tasks(id),
    note TEXT,
    expected_minutes INTEGER,
    created_at TEXT NOT NULL
  );
`;

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

  it("creates the daily_reports table (v3)", () => {
    expect(tableNames(db)).toContain("daily_reports");
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

  it("gives appeals a nullable response column (v2)", () => {
    expect(columnNames(db, "appeals")).toContain("response");

    const decisionId = insertDecision(db, insertSession(db));
    expect(() =>
      db
        .prepare(
          "INSERT INTO appeals (decision_id, content, verdict, response, created_at) VALUES (?, ?, ?, NULL, ?)",
        )
        .run(decisionId, "進言内容", "upheld", NOW),
    ).not.toThrow();
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
        "daily_reports",
        "sqlite_sequence",
      ].sort(),
    );
  });

  it("upgrades a v2 database to v3 (adds daily_reports) without touching existing tables", () => {
    // Simulate a pre-existing v2 database: fresh :memory: db, run only
    // migrations 1-2 by pragma-limiting, then upgrade to v3 via runMigrations.
    const v2Db = openDatabase(":memory:");
    v2Db.exec(V1_AND_V2_SQL);
    v2Db.pragma("user_version = 2");

    expect(tableNames(v2Db)).not.toContain("daily_reports");

    runMigrations(v2Db);

    expect(tableNames(v2Db)).toContain("daily_reports");
    expect(v2Db.pragma("user_version", { simple: true })).toBe(3);
    // existing tables/rows are untouched
    expect(tableNames(v2Db)).toContain("tasks");

    v2Db.close();
  });

  it("daily_reports.evening_session_id references sessions and rejects an unknown id", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("2026-08-14", "# 日報", 9999, NOW, NOW),
    ).toThrow();
  });

  it("enforces daily_reports.date UNIQUE", () => {
    const sessionId = insertSession(db, "evening");
    db.prepare(
      `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("2026-08-14", "# 日報1", sessionId, NOW, NOW);

    expect(() =>
      db
        .prepare(
          `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("2026-08-14", "# 日報2", sessionId, NOW, NOW),
    ).toThrow();
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
