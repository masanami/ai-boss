import type Database from "better-sqlite3";
import { toDateKey } from "../detection/time-utils.js";
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

/**
 * Sets `ended_at` to the current time and returns the updated session.
 * Idempotent: if the session is already ended, its existing `ended_at` is
 * left untouched and the session is simply returned as-is (Issue #47 —
 * `ended_at` is a UI-only marker, not consulted by the detection engine, so
 * re-ending has no side effect worth guarding against beyond not clobbering
 * the original timestamp). Returns undefined when the session does not
 * exist.
 */
export function endSession(
  db: Database.Database,
  id: number,
): Session | undefined {
  const session = findSessionById(db, id);
  if (!session) {
    return undefined;
  }
  if (session.ended_at !== null) {
    return session;
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(now, id);

  return findSessionById(db, id);
}

export type CreateSessionResult =
  | { ok: true; session: Session }
  | { ok: false; code: "evening_session_already_exists" };

/**
 * Whether an evening session whose `started_at` falls on `today`'s local
 * calendar date already exists, regardless of whether it has ended
 * (`ended_at`). A finished evening session still counts: the product rule is
 * "resume the existing evening session to redo the day's evening chat"
 * (docs/features/daily-report.md), not "one evening session while one is
 * open".
 */
function hasTodaysEveningSession(db: Database.Database, today: string): boolean {
  return listSessions(db, { type: "evening" }).some(
    (session) => toDateKey(new Date(session.started_at)) === today,
  );
}

/**
 * Creates a new session, atomically enforcing "at most one evening session
 * per local calendar day" (docs/features/daily-report.md — "夕会の1日1回制限の
 * 原子性"). The existence check and the INSERT run inside a single
 * `db.transaction`, so a concurrent request cannot interleave between the
 * check and the write on this single-process/single-writer SQLite
 * connection. Morning and adhoc sessions are never limited and always
 * succeed. This is the entry point `POST /api/sessions` should call; the
 * plain `insertSession` above stays unrestricted for other call sites
 * (schedulers, tests, other repositories) that need to seed sessions without
 * the daily-limit check.
 */
export function createSession(
  db: Database.Database,
  record: NewSessionRecord,
): CreateSessionResult {
  const attempt = db.transaction((): CreateSessionResult => {
    if (record.type === "evening") {
      const today = toDateKey(new Date());
      if (hasTodaysEveningSession(db, today)) {
        return { ok: false, code: "evening_session_already_exists" };
      }
    }

    return { ok: true, session: insertSession(db, record) };
  });

  return attempt();
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
