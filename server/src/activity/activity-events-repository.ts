import type Database from "better-sqlite3";
import type { ActivityEvent, ActivityEventType } from "./activity-event.js";

export interface NewActivityEventRecord {
  type: ActivityEventType;
  task_id?: number | null;
  note?: string | null;
  expected_minutes?: number | null;
}

/**
 * Records an activity signal into `activity_events`, the single input for
 * the (future) slacking-detection rule engine. `created_at` is server-
 * managed. Optional fields default to `null` when omitted.
 *
 * This is a repository-level helper only (no HTTP endpoint in this
 * ticket) — callers such as the chat message flow invoke it directly.
 */
export function recordActivityEvent(
  db: Database.Database,
  record: NewActivityEventRecord,
): ActivityEvent {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO activity_events (type, task_id, note, expected_minutes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      record.type,
      record.task_id ?? null,
      record.note ?? null,
      record.expected_minutes ?? null,
      now,
    );

  const event = db
    .prepare("SELECT * FROM activity_events WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ActivityEvent | undefined;
  if (!event) {
    throw new Error("failed to read back the recorded activity event");
  }
  return event;
}
