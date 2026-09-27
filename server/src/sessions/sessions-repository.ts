import type { Db } from "../db/db-port.js";
import { toDateKey } from "../detection/time-utils.js";
import type { RecentSessionSummary } from "../boss/persona-prompt.js";
import type { Session, SessionType } from "./session.js";

export interface NewSessionRecord {
  type: SessionType;
}

export async function findSessionById(
  db: Db,
  id: number,
): Promise<Session | undefined> {
  return db.get<Session>("SELECT * FROM sessions WHERE id = ?", [id]);
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
export async function insertSession(
  db: Db,
  record: NewSessionRecord,
): Promise<Session> {
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO sessions (type, started_at, ended_at, summary)
       VALUES (?, ?, NULL, NULL)`,
    [record.type, now],
  );

  const session = await findSessionById(db, result.lastInsertRowid);
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
export async function endSession(
  db: Db,
  id: number,
): Promise<Session | undefined> {
  const session = await findSessionById(db, id);
  if (!session) {
    return undefined;
  }
  if (session.ended_at !== null) {
    return session;
  }

  const now = new Date().toISOString();
  await db.run("UPDATE sessions SET ended_at = ? WHERE id = ?", [now, id]);

  return await findSessionById(db, id);
}

export type CreateSessionResult =
  | { ok: true; session: Session }
  | { ok: false; code: "evening_session_already_exists" };

/**
 * Finds the evening session (`type = "evening"`) whose `started_at` falls on
 * the given local calendar date key (`dateKey`, {@link toDateKey}'s
 * `YYYY-MM-DD` format), regardless of whether it has ended. `listSessions`
 * orders by `started_at DESC, id DESC`, so if more than one matches (should
 * not normally happen — see `createSession`'s daily-limit enforcement below),
 * the most recent one wins (attribution basis:
 * docs/adr/0007-local-calendar-day-basis.md 決定 4).
 *
 * Shared by three callers that all need "the evening session that started on
 * local calendar day X", so the query lives in one place rather than being
 * duplicated per caller: `hasTodaysEveningSession` (below, the
 * one-evening-session-per-day constraint check), `generate-daily-report.ts`'s
 * default (no-parameter) target-session resolution (`toDateKey(now)`), and
 * `reports-routes.ts`'s `POST /generate` `date`-parameter resolution (manual
 * regeneration for a specific day, Issue #297).
 */
export async function findEveningSessionByDateKey(
  db: Db,
  dateKey: string,
): Promise<Session | undefined> {
  return (await listSessions(db, { type: "evening" })).find(
    (session) => toDateKey(new Date(session.started_at)) === dateKey,
  );
}

/**
 * Whether an evening session whose `started_at` falls on `today`'s local
 * calendar date already exists, regardless of whether it has ended
 * (`ended_at`). A finished evening session still counts: the product rule is
 * "resume the existing evening session to redo the day's evening chat"
 * (docs/adr/0008-evening-dialogue-prerequisite.md 決定 4), not "one evening
 * session while one is open".
 */
async function hasTodaysEveningSession(db: Db, today: string): Promise<boolean> {
  return await findEveningSessionByDateKey(db, today) !== undefined;
}

/**
 * Creates a new session, atomically enforcing "at most one evening session
 * per local calendar day" (docs/adr/0008-evening-dialogue-prerequisite.md
 * 決定 4). The existence check and the INSERT run inside a single
 * `db.transaction` (T5・#605), so a concurrent request cannot interleave
 * between the check and the write: the port's serialization lock holds every
 * other flow's DB operation until the transaction ends (AC-10). Morning and adhoc sessions are never limited and always
 * succeed. This is the entry point `POST /api/sessions` should call; the
 * plain `insertSession` above stays unrestricted for other call sites
 * (schedulers, tests, other repositories) that need to seed sessions without
 * the daily-limit check.
 */
export async function createSession(
  db: Db,
  record: NewSessionRecord,
): Promise<CreateSessionResult> {
  return db.transaction(async (tx): Promise<CreateSessionResult> => {
    if (record.type === "evening") {
      const today = toDateKey(new Date());
      if (await hasTodaysEveningSession(tx, today)) {
        return { ok: false, code: "evening_session_already_exists" };
      }
    }

    return { ok: true, session: await insertSession(tx, record) };
  });
}

export interface ListSessionsFilter {
  type?: SessionType;
}

/**
 * Returns sessions ordered by `started_at` descending, with `id` descending
 * as a tie-breaker so the most recently created session sorts first when
 * timestamps collide. Optionally filtered by `type`.
 */
export async function listSessions(
  db: Db,
  filter?: ListSessionsFilter,
): Promise<Session[]> {
  if (filter?.type) {
    return db.all<Session>(
      "SELECT * FROM sessions WHERE type = ? ORDER BY started_at DESC, id DESC",
      [filter.type],
    );
  }

  return db.all<Session>("SELECT * FROM sessions ORDER BY started_at DESC, id DESC");
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
export async function updateSessionSummary(
  db: Db,
  id: number,
  summary: string,
): Promise<Session | undefined> {
  const session = await findSessionById(db, id);
  if (!session) {
    return undefined;
  }

  await db.run(
    "UPDATE sessions SET summary = ? WHERE id = ? AND summary IS NULL",
    [summary, id],
  );

  // Re-read regardless of whether this call won the race: on a loss the row
  // holds the summary stored by the winner, which is what callers must use.
  return await findSessionById(db, id);
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
export async function listRecentSessionSummaries(
  db: Db,
  limit: number,
): Promise<RecentSessionSummary[]> {
  const rows = await db.all<SessionSummaryRow>(
    `SELECT type, summary, COALESCE(ended_at, started_at) AS reported_at
       FROM sessions
       WHERE summary IS NOT NULL AND summary != ''
       ORDER BY COALESCE(ended_at, started_at) DESC, id DESC
       LIMIT ?`,
    [limit],
  );

  return rows.map((row) => ({
    type: row.type,
    content: row.summary,
    reportedAt: row.reported_at,
  }));
}
