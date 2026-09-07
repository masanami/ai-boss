import type Database from "better-sqlite3";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "../activity/local-day.js";
import type { Message, MessageRole } from "./message.js";

export interface NewMessageRecord {
  session_id: number;
  role: MessageRole;
  content: string;
  /**
   * `true` when this reply ended early and is not a complete answer (#254) —
   * the user stopped the generation, or the LLM call failed/timed out after
   * some text had already been streamed. Defaults to `false`, which is what
   * every pre-existing call site means: a reply that ran to completion.
   *
   * See `Message.interrupted` for why the column is not "the user stopped
   * it".
   */
  interrupted?: boolean;
}

/**
 * Inserts a new message with a server-managed `created_at` timestamp and
 * returns the persisted row.
 */
export function insertMessage(
  db: Database.Database,
  record: NewMessageRecord,
): Message {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO messages (session_id, role, content, interrupted, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      record.session_id,
      record.role,
      record.content,
      record.interrupted === true ? 1 : 0,
      now,
    );

  const message = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Message | undefined;
  if (!message) {
    throw new Error("failed to read back the inserted message");
  }
  return message;
}

/**
 * Returns all messages for a session ordered by `created_at` ascending,
 * with `id` ascending as a tie-breaker for deterministic ordering.
 */
export function listMessagesBySessionId(
  db: Database.Database,
  sessionId: number,
): Message[] {
  return db
    .prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(sessionId) as Message[];
}

/**
 * Returns the message with `messageId`, but only when it belongs to
 * `sessionId`. Returns `undefined` both when no such message exists at all
 * and when it exists but belongs to a different session — the caller cannot
 * tell the two apart, which is intentional: this is the single place that
 * rejects cross-session references (#375, chat-message-rewrite decision 3).
 */
export function findMessageInSession(
  db: Database.Database,
  sessionId: number,
  messageId: number,
): Message | undefined {
  return db
    .prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
    .get(messageId, sessionId) as Message | undefined;
}

/**
 * Deletes `fromMessageId` and every message after it, within the same
 * session, using the same `created_at ASC, id ASC` order as
 * `listMessagesBySessionId` — the "rewrite" (truncate-and-resend) primitive
 * behind Issue #255's edit-and-redo feature
 * (docs/features/chat-message-rewrite.md decisions 1 and 2).
 *
 * The range condition deliberately does not use `id >= ?` alone:
 * `created_at` is a millisecond-precision ISO string and two rows can share
 * the same value, so the tie-break has to mirror `listMessagesBySessionId`'s
 * `id ASC` exactly, or "what you see is what gets deleted" would not hold.
 *
 * Returns 0 without deleting anything when `fromMessageId` does not belong
 * to `sessionId` (including when it does not exist at all) — same
 * cross-session rejection as `findMessageInSession`, reused here to look up
 * the anchor row's `created_at`.
 *
 * **Opens no transaction of its own.** The rewrite flow must not leave a
 * state where the history was truncated but the rewritten message never
 * landed, so the caller (`chat-messages-route.ts`) wraps this call and the
 * following `insertMessage` in a single `db.transaction`
 * (ADR 0005 決定 5 / chat-message-rewrite「機能全体の設計」).
 */
export function deleteMessagesFrom(
  db: Database.Database,
  sessionId: number,
  fromMessageId: number,
): number {
  const anchor = findMessageInSession(db, sessionId, fromMessageId);
  if (!anchor) {
    return 0;
  }

  const result = db
    .prepare(
      `DELETE FROM messages
       WHERE session_id = ?
         AND (created_at > ? OR (created_at = ? AND id >= ?))`,
    )
    .run(sessionId, anchor.created_at, anchor.created_at, fromMessageId);

  return result.changes;
}

/**
 * Returns the number of `role = 'user'` messages recorded for `sessionId` —
 * the other of the two counts `mentoring-gate.ts`'s `isMentoringComplete` (a
 * pure function that never touches the DB) needs from its caller (#276
 * 判断3). Scoped to `session_id` so a user message in another session never
 * counts toward this one, and `role = 'boss'` rows (including the meeting
 * opening line, `meeting-opening.ts`) are excluded.
 */
export function countUserMessagesBySessionId(
  db: Database.Database,
  sessionId: number,
): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND role = 'user'",
    )
    .get(sessionId) as { count: number };
  return row.count;
}

/**
 * Returns messages belonging to `adhoc` sessions whose `created_at` falls on
 * `now`'s local calendar day, ordered by `created_at` ascending with `id`
 * ascending as a tie-breaker (same deterministic ordering as
 * `listMessagesBySessionId`). Morning/evening session messages are excluded.
 *
 * "Today" is the half-open range `[当日ローカル 00:00, 翌ローカル暦日 00:00)`
 * (ADR 0007 決定3), mirroring `today-escalation.ts`'s
 * `calculateTodayMaxEscalationLevel`: both boundaries are derived from the
 * same `now` so a future-dated row (clock/timezone rolled back) cannot widen
 * the window.
 *
 * Reads the `messages` table live on every call, so a message truncated by a
 * rewrite (`deleteMessagesFrom` above, Issue #255) can never surface here:
 * the row is physically gone by the time this runs. That is what keeps
 * 「書き直した後、元の発言はボスの文脈に含まれない」 true for *this* context
 * path too, not just the session's own conversation history — see
 * `chat-messages-route.ts`, where the truncation transaction is ordered
 * ahead of both context reads.
 */
export function listTodaysAdhocMessages(
  db: Database.Database,
  now: Date,
): Message[] {
  return db
    .prepare(
      `SELECT messages.*
       FROM messages
       JOIN sessions ON sessions.id = messages.session_id
       WHERE sessions.type = 'adhoc'
         AND messages.created_at >= ?
         AND messages.created_at < ?
       ORDER BY messages.created_at ASC, messages.id ASC`,
    )
    .all(startOfLocalDayIso(now), startOfNextLocalDayIso(now)) as Message[];
}
