import type Database from "better-sqlite3";
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
