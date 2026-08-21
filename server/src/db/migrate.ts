import type Database from "better-sqlite3";

const MIGRATIONS: Record<number, string> = {
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
};

/**
 * Applies pending schema migrations using `PRAGMA user_version` as the
 * migration cursor. Safe to call multiple times (idempotent): migrations
 * already applied (version <= current user_version) are skipped.
 *
 * Each version is applied atomically: the migration SQL and the
 * `user_version` update run in a single transaction (`PRAGMA user_version`
 * participates in the transaction), so an interruption or failure leaves the
 * database exactly at the previous version boundary — never in a
 * "applied but not recorded" state that would re-run non-idempotent
 * statements on the next start (#175). The transaction is per version (not
 * around the whole loop) so that versions applied before a failure stay
 * committed, keeping recovery simple.
 *
 * @param migrations - Version-keyed migration SQL. Defaults to the real
 *   schema; injectable so tests can exercise failure scenarios. The target
 *   (latest) version is derived from the highest key, and every version from
 *   the current one up to it must be present — a gap in the keys is a
 *   programming error and fails fast instead of being silently skipped.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Record<number, string> = MIGRATIONS,
): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const versions = Object.keys(migrations).map(Number);
  const latestVersion = versions.length === 0 ? currentVersion : Math.max(...versions);

  let appliedVersion = currentVersion;

  for (let version = currentVersion + 1; version <= latestVersion; version++) {
    const sql = migrations[version];
    if (sql === undefined) {
      throw new Error(
        `missing migration for version ${version} (latest known version is ${latestVersion}); the database remains at version ${appliedVersion}`,
      );
    }

    const applyVersion = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });

    try {
      applyVersion();
    } catch (error) {
      throw new Error(
        `migration to version ${version} failed; its changes were rolled back and the database remains at version ${appliedVersion}`,
        { cause: error },
      );
    }

    appliedVersion = version;
  }
}
