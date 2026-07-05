import type Database from "better-sqlite3";
import type { Session, SessionType } from "./session.js";

export interface NewSessionRecord {
  type: SessionType;
}

export function findSessionById(
  db: Database.Database,
  id: number,
): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | Session
    | undefined;
}

/**
 * Inserts a new session with a server-managed `started_at` timestamp.
 * `ended_at` / `summary` are left null (set later by the morning/evening
 * flow, out of scope for this ticket). Returns the persisted row.
 */
export function insertSession(
  db: Database.Database,
  record: NewSessionRecord,
): Session {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO sessions (type, started_at, ended_at, summary)
       VALUES (?, ?, NULL, NULL)`,
    )
    .run(record.type, now);

  const session = findSessionById(db, Number(result.lastInsertRowid));
  if (!session) {
    throw new Error("failed to read back the inserted session");
  }
  return session;
}

export interface ListSessionsFilter {
  type?: SessionType;
}

/**
 * Returns sessions ordered by `started_at` descending, with `id` descending
 * as a tie-breaker so the most recently created session sorts first when
 * timestamps collide. Optionally filtered by `type`.
 */
export function listSessions(
  db: Database.Database,
  filter?: ListSessionsFilter,
): Session[] {
  if (filter?.type) {
    return db
      .prepare(
        "SELECT * FROM sessions WHERE type = ? ORDER BY started_at DESC, id DESC",
      )
      .all(filter.type) as Session[];
  }

  return db
    .prepare("SELECT * FROM sessions ORDER BY started_at DESC, id DESC")
    .all() as Session[];
}
