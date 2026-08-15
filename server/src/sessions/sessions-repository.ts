import type Database from "better-sqlite3";
import { toDateKey } from "../detection/time-utils.js";
import type { RecentSessionSummary } from "../boss/persona-prompt.js";
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
 * `ended_at` / `summary` are left null. `ended_at` is set later by
 * `endSession` (session end). `summary` is set later by `updateSessionSummary`
 * — driven by `POST /:id/end` for morning/evening sessions, via
 * `session-summary.ts`'s best-effort generator (Issue #96); adhoc sessions
 * are not summarized (no natural "end" trigger in the UI, see that ticket's
 * PR for the full rationale). Returns the persisted row.
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

/**
 * Sets `summary` on the given session **only when it is still null**, and
 * returns the current row. Returns `undefined` when the session does not
 * exist.
 *
 * The `WHERE summary IS NULL` guard makes this a compare-and-set: two
 * concurrent `POST /:id/end` requests can both observe `summary === null`
 * before either finishes generating, and an unconditional UPDATE would let
 * the slower one overwrite the summary the faster one already stored. Losing
 * that race is not an error — the row already holds a valid summary, so the
 * caller simply gets the stored one back.
 */
export function updateSessionSummary(
  db: Database.Database,
  id: number,
  summary: string,
): Session | undefined {
  const session = findSessionById(db, id);
  if (!session) {
    return undefined;
  }

  db.prepare(
    "UPDATE sessions SET summary = ? WHERE id = ? AND summary IS NULL",
  ).run(summary, id);

  // Re-read regardless of whether this call won the race: on a loss the row
  // holds the summary stored by the winner, which is what callers must use.
  return findSessionById(db, id);
}

interface SessionSummaryRow {
  type: SessionType;
  summary: string;
  reported_at: string;
}

/**
 * Returns the most recent summarized sessions (summary non-null and
 * non-empty), ordered by `ended_at` descending — falling back to
 * `started_at` when `ended_at` is null — with `id` descending as a
 * tie-breaker. Shaped for `buildPersonaPrompt`'s
 * `PersonaPromptContext.recentSessionSummaries`, mirroring how
 * `decisions-repository.ts`'s `listRecentDecisions` maps to `RecentDecision`.
 */
export function listRecentSessionSummaries(
  db: Database.Database,
  limit: number,
): RecentSessionSummary[] {
  const rows = db
    .prepare(
      `SELECT type, summary, COALESCE(ended_at, started_at) AS reported_at
       FROM sessions
       WHERE summary IS NOT NULL AND summary != ''
       ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as SessionSummaryRow[];

  return rows.map((row) => ({
    type: row.type,
    content: row.summary,
    reportedAt: row.reported_at,
  }));
}
