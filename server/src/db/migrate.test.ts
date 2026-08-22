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

// Self-contained snapshot of the v1+v2+v3 schema (duplicated from
// `MIGRATIONS[1]`/`MIGRATIONS[2]`/`MIGRATIONS[3]` in migrate.ts), used only
// to simulate a pre-existing v3 database for the "upgrades a v3 database to
// v4" test below. Intentionally not imported from migrate.ts: a v3
// database's schema must stay fixed regardless of future edits to the
// *current* MIGRATIONS map.
const V1_THROUGH_V3_SQL = `
  ${V1_AND_V2_SQL}

  CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    evening_session_id INTEGER NOT NULL REFERENCES sessions(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

  // Version-keyed migrations with an injected failure: version 2's first
  // statement succeeds, then the duplicate-PK INSERT fails at runtime. Used
  // to verify that a failing version is rolled back as a whole (schema and
  // user_version) instead of leaving partially applied statements behind.
  const FAILING_MIGRATIONS: Record<number, string> = {
    1: "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
    2: `
      CREATE TABLE second_table (id INTEGER PRIMARY KEY);
      INSERT INTO second_table (id) VALUES (1), (1);
    `,
  };

  it("rolls back every statement of a failed version, leaving schema and user_version at the previous version boundary", () => {
    const failingDb = openDatabase(":memory:");

    expect(() => runMigrations(failingDb, FAILING_MIGRATIONS)).toThrow();

    // Version 1 (applied before the failure) stays committed; version 2 is
    // rolled back entirely, including its successful CREATE TABLE statement.
    expect(tableNames(failingDb)).toContain("first_table");
    expect(tableNames(failingDb)).not.toContain("second_table");
    expect(failingDb.pragma("user_version", { simple: true })).toBe(1);

    failingDb.close();
  });

  it("re-running after an interrupted migration brings the database up to the latest version", () => {
    // An interrupted (rolled-back) migration leaves the DB exactly at the
    // previous version boundary, so once the transient cause is gone the
    // *same* migration map is re-run unchanged and completes — no version's
    // SQL is rewritten after the fact (ADR 0005 decision 4).
    const interruptibleMigrations: Record<number, string> = {
      1: "CREATE TABLE seed_rows (value INTEGER);",
      2: `
        CREATE TABLE second_table (id INTEGER PRIMARY KEY);
        INSERT INTO second_table (id) SELECT value FROM seed_rows;
      `,
    };

    // Database already at version 1, holding transient data that makes
    // version 2 fail (duplicate values violate second_table's PK).
    const interruptedDb = openDatabase(":memory:");
    interruptedDb.exec("CREATE TABLE seed_rows (value INTEGER);");
    interruptedDb.pragma("user_version = 1");
    interruptedDb.prepare("INSERT INTO seed_rows (value) VALUES (1), (1)").run();

    expect(() =>
      runMigrations(interruptedDb, interruptibleMigrations),
    ).toThrow();
    expect(interruptedDb.pragma("user_version", { simple: true })).toBe(1);

    // Transient cause resolved (conflicting row removed); re-run the same map.
    interruptedDb.prepare("DELETE FROM seed_rows WHERE rowid > 1").run();
    runMigrations(interruptedDb, interruptibleMigrations);

    expect(interruptedDb.pragma("user_version", { simple: true })).toBe(2);
    expect(tableNames(interruptedDb)).toContain("second_table");

    interruptedDb.close();
  });

  it("fails fast, without applying any migration, when the database's user_version is ahead of the latest known migration version", () => {
    // Simulates opening a DB created by a newer build of the app with an
    // older build: the loop from currentVersion + 1 to latestVersion would
    // run zero times and silently return, leaving the mismatch undetected.
    // The guard must fire before any migration in `migrations` is attempted.
    //
    // Uses an injected local map (same pattern as FAILING_MIGRATIONS above
    // and gappedMigrations below) rather than the live default MIGRATIONS
    // map, so this test stays independent of the app's current latest
    // schema version and doesn't need updating whenever a new migration is
    // added (#204 self-review).
    const futureDb = openDatabase(":memory:");
    futureDb.pragma("user_version = 9");
    const smallMigrations: Record<number, string> = {
      1: "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
      2: "CREATE TABLE second_table (id INTEGER PRIMARY KEY);",
    };

    // Order-sensitive: the DB's user_version (9) must appear before the
    // implementation's latest known version (2) so the two numbers can't be
    // silently transposed (#204 AC-1).
    expect(() => runMigrations(futureDb, smallMigrations)).toThrow(
      /user_version is 9[\s\S]*latest known migration version is 2/,
    );
    // user_version and schema are left untouched (no migration was attempted).
    expect(futureDb.pragma("user_version", { simple: true })).toBe(9);
    expect(tableNames(futureDb)).toEqual([]);

    futureDb.close();
  });

  it("fails fast with the missing version number when the migrations map has a gap", () => {
    const gappedDb = openDatabase(":memory:");
    const gappedMigrations: Record<number, string> = {
      1: "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
      3: "CREATE TABLE third_table (id INTEGER PRIMARY KEY);",
    };

    expect(() => runMigrations(gappedDb, gappedMigrations)).toThrow(
      /missing migration for version 2/,
    );
    // Versions applied before the gap stay committed; nothing is skipped.
    expect(gappedDb.pragma("user_version", { simple: true })).toBe(1);
    expect(tableNames(gappedDb)).not.toContain("third_table");

    gappedDb.close();
  });

  it("wraps a migration failure in an error naming the failed version", () => {
    // Legacy half-migrated state from the pre-#175 non-atomic implementation:
    // v2's ALTER TABLE was applied but user_version was never advanced.
    // Re-running v2 fails (duplicate column), and the error must say which
    // version failed instead of surfacing the raw SQLite message alone.
    const legacyDb = openDatabase(":memory:");
    legacyDb.exec(V1_AND_V2_SQL);
    legacyDb.pragma("user_version = 1");

    expect(() => runMigrations(legacyDb)).toThrow(/version 2/);

    legacyDb.close();
  });

  it("keeps the original SQLite error as the cause of the wrapped migration error", () => {
    const failingDb = openDatabase(":memory:");

    let thrown: unknown;
    try {
      runMigrations(failingDb, FAILING_MIGRATIONS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toMatch(/UNIQUE/);

    failingDb.close();
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
    // runMigrations always advances to the latest known version (v3 adds
    // daily_reports on the way; v4 then rebuilds tasks/activity_events).
    expect(v2Db.pragma("user_version", { simple: true })).toBe(4);
    // existing tables/rows are untouched
    expect(tableNames(v2Db)).toContain("tasks");

    v2Db.close();
  });

  it("upgrades a v3 database to v4 (adds paused status and task_pause type) without touching existing tables", () => {
    const v3Db = openDatabase(":memory:");
    v3Db.exec(V1_THROUGH_V3_SQL);
    v3Db.pragma("user_version = 3");

    const taskId = Number(
      v3Db
        .prepare(
          "INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("既存タスク", "in_progress", NOW, NOW).lastInsertRowid,
    );
    v3Db
      .prepare(
        "INSERT INTO activity_events (type, task_id, created_at) VALUES (?, ?, ?)",
      )
      .run("task_start", taskId, NOW);

    runMigrations(v3Db);

    expect(v3Db.pragma("user_version", { simple: true })).toBe(4);
    expect(tableNames(v3Db)).toContain("tasks");
    expect(tableNames(v3Db)).toContain("activity_events");

    const task = v3Db.prepare("SELECT title, status FROM tasks WHERE id = ?").get(
      taskId,
    ) as { title: string; status: string };
    expect(task).toEqual({ title: "既存タスク", status: "in_progress" });

    const event = v3Db
      .prepare("SELECT type, task_id FROM activity_events WHERE task_id = ?")
      .get(taskId) as { type: string; task_id: number };
    expect(event).toEqual({ type: "task_start", task_id: taskId });

    v3Db.close();
  });

  it("accepts tasks.status = 'paused' after migrating to v4", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("タスク", "paused", NOW, NOW),
    ).not.toThrow();
  });

  it("accepts activity_events.type = 'task_pause' after migrating to v4", () => {
    expect(() =>
      db
        .prepare("INSERT INTO activity_events (type, created_at) VALUES (?, ?)")
        .run("task_pause", NOW),
    ).not.toThrow();
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
    it.each([["todo"], ["in_progress"], ["paused"], ["done"], ["dropped"]])(
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
      ["task_pause"],
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
