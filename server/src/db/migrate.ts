import type Database from "better-sqlite3";

/**
 * A migration is either a plain SQL string (applied inside a single
 * version-scoped transaction that also advances `user_version`, as before),
 * or a function that takes full control of its own transaction and
 * `user_version` update. Version 4 needs the latter: rebuilding `tasks` and
 * `activity_events` to widen their CHECK constraints requires toggling
 * `PRAGMA foreign_keys` *outside* the transaction (SQLite's 12-step table
 * rebuild procedure — toggling it inside a transaction does not suppress the
 * FK check, it just defers the failure to COMMIT), which a bare SQL string
 * cannot express (#183).
 */
type MigrationEntry = string | ((db: Database.Database) => void);

// Rebuilds `tasks` and `activity_events` to add `'paused'` / `'task_pause'`
// to their CHECK constraints (#179 decision 1). SQLite has no `ALTER TABLE
// ... ADD CHECK`, so both tables are recreated with the widened constraint,
// their rows copied over by explicit column list (preserves `id`, and thus
// referencing rows in `decisions`/`activity_events`), then the old table is
// dropped and the new one renamed into place. `tasks` is rebuilt first so
// that by the time `activity_events` (which references `tasks(id)`) is
// rebuilt, the final `tasks` table already exists under its permanent name.
const V4_REBUILD_SQL = `
  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'work',
    priority TEXT,
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'todo'
      CHECK (status IN ('todo', 'in_progress', 'paused', 'done', 'dropped')),
    boss_comment TEXT,
    estimated_minutes INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  INSERT INTO tasks_new (
    id, title, description, category, priority, due_at, status,
    boss_comment, estimated_minutes, created_at, updated_at, completed_at
  )
  SELECT
    id, title, description, category, priority, due_at, status,
    boss_comment, estimated_minutes, created_at, updated_at, completed_at
  FROM tasks;

  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;

  CREATE TABLE activity_events_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL
      CHECK (type IN (
        'task_start', 'break_start', 'break_end',
        'checkin', 'chat_message', 'task_update', 'task_pause'
      )),
    task_id INTEGER REFERENCES tasks(id),
    note TEXT,
    expected_minutes INTEGER,
    created_at TEXT NOT NULL
  );

  INSERT INTO activity_events_new (
    id, type, task_id, note, expected_minutes, created_at
  )
  SELECT
    id, type, task_id, note, expected_minutes, created_at
  FROM activity_events;

  DROP TABLE activity_events;
  ALTER TABLE activity_events_new RENAME TO activity_events;
`;

/**
 * Throws if `PRAGMA foreign_key_check` reports any violation in the given
 * tables. Scoped to the tables affected by the v4 rebuild (`activity_events`
 * itself, and `decisions`, which also references `tasks(id)`) rather than a
 * full-database check, so pre-existing orphan rows in unrelated tables don't
 * newly block startup (#179 lead's judgment call).
 */
function assertNoForeignKeyViolations(
  db: Database.Database,
  tables: string[],
): void {
  for (const table of tables) {
    const violations = db.pragma(`foreign_key_check(${table})`) as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `foreign key violations found in "${table}" after migrating to version 4: ${JSON.stringify(violations)}`,
      );
    }
  }
}

// `foreign_keys` must be turned OFF *outside* any transaction: toggling it
// inside a transaction does not suppress the FK check during the rebuild,
// it only defers the failure to COMMIT (confirmed experimentally, #179). The
// `finally` guarantees `foreign_keys` is restored to ON even if the rebuild
// or the FK check throws, so a failed v4 migration never leaves FK
// enforcement silently disabled (would otherwise regress G-170-80).
function migrateToV4(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  try {
    const apply = db.transaction(() => {
      db.exec(V4_REBUILD_SQL);
      assertNoForeignKeyViolations(db, ["activity_events", "decisions"]);
      db.pragma("user_version = 4");
    });
    apply();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

const MIGRATIONS: Record<number, MigrationEntry> = {
  1: `
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
      created_at TEXT NOT NULL
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
  `,
  // 進言 → 再裁定（#48）: ボスの再裁定文を appeals に記録するための追加列。
  // v1 の appeals テーブル定義は変更しない（既存 CHECK 制約はそのまま）。
  2: `
    ALTER TABLE appeals ADD COLUMN response TEXT;
  `,
  // 日報生成（#100 / #106）: 1日1行・再生成は同日行の UPSERT（上書き）で保存する
  // daily_reports テーブルを新設。既存テーブルの変更は行わない
  // （docs/adr/0005-sqlite-schema-policy.md 決定 4・保証 G-170-78 / G-170-80）。
  3: `
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,           -- ローカル日付キー（toDateKey 形式）
      content TEXT NOT NULL,               -- 日報 Markdown 全文
      evening_session_id INTEGER NOT NULL REFERENCES sessions(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  // 一時停止（#179 判断1）: tasks.status に 'paused'、activity_events.type に
  // 'task_pause' を追加するため両テーブルを再構築する（#183）。
  4: migrateToV4,
};

/**
 * Applies pending schema migrations using `PRAGMA user_version` as the
 * migration cursor. Safe to call multiple times (idempotent): migrations
 * already applied (version <= current user_version) are skipped.
 *
 * Each version is applied atomically: for a plain SQL string entry, the
 * migration SQL and the `user_version` update run in a single transaction
 * (`PRAGMA user_version` participates in the transaction), so an
 * interruption or failure leaves the database exactly at the previous
 * version boundary — never in a "applied but not recorded" state that would
 * re-run non-idempotent statements on the next start (#175). The transaction
 * is per version (not around the whole loop) so that versions applied
 * before a failure stay committed, keeping recovery simple. A function
 * entry (e.g. v4) instead owns its own transaction and `user_version`
 * update, for migrations that need control outside of it (e.g. toggling
 * `PRAGMA foreign_keys` around a table rebuild, #183) — but is expected to
 * uphold the same atomicity contract.
 *
 * @param migrations - Version-keyed migration SQL or migration function.
 *   Defaults to the real schema; injectable so tests can exercise failure
 *   scenarios. The target (latest) version is derived from the highest key,
 *   and every version from the current one up to it must be present — a gap
 *   in the keys is a programming error and fails fast instead of being
 *   silently skipped.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Record<number, MigrationEntry> = MIGRATIONS,
): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const versions = Object.keys(migrations).map(Number);
  const latestVersion = versions.length === 0 ? currentVersion : Math.max(...versions);

  let appliedVersion = currentVersion;

  for (let version = currentVersion + 1; version <= latestVersion; version++) {
    const migration = migrations[version];
    if (migration === undefined) {
      throw new Error(
        `missing migration for version ${version} (latest known version is ${latestVersion}); the database remains at version ${appliedVersion}`,
      );
    }

    try {
      if (typeof migration === "function") {
        // The function owns its own transaction and `user_version` update
        // (see `migrateToV4`): version-scoped wrapping like the string case
        // below cannot express toggling `PRAGMA foreign_keys` outside the
        // transaction.
        migration(db);
      } else {
        const applyVersion = db.transaction(() => {
          db.exec(migration);
          db.pragma(`user_version = ${version}`);
        });
        applyVersion();
      }
    } catch (error) {
      throw new Error(
        `migration to version ${version} failed; its changes were rolled back and the database remains at version ${appliedVersion}`,
        { cause: error },
      );
    }

    appliedVersion = version;
  }
}
