import type Database from "better-sqlite3";
import type { Message, MessageRole } from "./message.js";

export interface NewMessageRecord {
  session_id: number;
  role: MessageRole;
  content: string;
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
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(record.session_id, record.role, record.content, now);

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
