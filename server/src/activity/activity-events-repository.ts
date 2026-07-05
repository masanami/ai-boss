// This module intentionally has no imports from other feature directories
// (tasks/, sessions/, boss/, ...). `activity_events` is the single input for
// the slacking-detection rule engine (see docs/features/ai-boss-mvp.md,
// "クリティカル設計決定 > サボり検知のシグナル源とエスカレーション"), and
// keeping this repository dependency-free avoids circular imports as other
// modules (e.g. tasks-repository.ts) call into it to record signals.
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

/**
 * Returns all activity events created at or after `isoTime`, ordered by
 * `created_at` ascending (id as a tie-breaker). Used by callers such as
 * `GET /api/activity/today` and, later, the slacking-detection rule engine
 * to build its input window.
 */
export function listEventsSince(
  db: Database.Database,
  isoTime: string,
): ActivityEvent[] {
  return db
    .prepare(
      "SELECT * FROM activity_events WHERE created_at >= ? ORDER BY created_at ASC, id ASC",
    )
    .all(isoTime) as ActivityEvent[];
}

/**
 * Returns the most recently recorded activity event (by `created_at`, with
 * `id` as a tie-breaker), or `undefined` if no events have been recorded
 * yet.
 *
 * No caller exists in this ticket (#35) — it is a read primitive for the
 * slacking-detection rule engine wiring in the follow-up ticket (#38),
 * which will use it to determine the last signal for silence detection and
 * escalation reset.
 */
export function findLatestEvent(
  db: Database.Database,
): ActivityEvent | undefined {
  return db
    .prepare(
      "SELECT * FROM activity_events ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get() as ActivityEvent | undefined;
}
