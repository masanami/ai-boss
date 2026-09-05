// This module intentionally has no imports from other feature directories
// (tasks/, sessions/, boss/, ...). `activity_events` is the single input for
// the slacking-detection rule engine (see docs/adr/0004-deterministic-detection-engine.md
// 決定 1「活動シグナルを activity_events に一元化する」), and
// keeping this repository dependency-free avoids circular imports as other
// modules (e.g. tasks-repository.ts) call into it to record signals.
import type Database from "better-sqlite3";
import type { ActivityEvent, ActivityEventType } from "./activity-event.js";

export interface NewActivityEventRecord {
  type: ActivityEventType;
  task_id?: number | null;
  note?: string | null;
  expected_minutes?: number | null;
  created_at?: string;
}

/**
 * Records an activity signal into `activity_events`, the single input for
 * the (future) slacking-detection rule engine. `created_at` defaults to the
 * server's current time, but callers may pass an explicit value (Issue #350:
 * backdated checkins via `occurred_at`) — the caller is responsible for
 * normalizing/validating it first (`checkins-routes.ts` does this). Optional
 * fields default to `null` when omitted.
 *
 * This is a repository-level helper only (no HTTP endpoint in this
 * ticket) — callers such as the chat message flow invoke it directly.
 */
export function recordActivityEvent(
  db: Database.Database,
  record: NewActivityEventRecord,
): ActivityEvent {
  const createdAt = record.created_at ?? new Date().toISOString();

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
      createdAt,
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
 * Returns all activity events created at or after `isoTime` (and, when
 * `untilIsoExclusive` is given, strictly before it — an *exclusive* upper
 * bound), ordered by `created_at` ascending (id as a tie-breaker).
 *
 * Used by callers such as `GET /api/activity/today` (Issue #230: passes
 * the next local day's start as `untilIsoExclusive` so the query itself
 * bounds "today" instead of relying on the caller never having
 * future-dated rows) and, with no upper bound, the slacking-detection rule
 * engine to build its full-history input window.
 *
 * The upper bound of this function is *exclusive* per ADR 0007 決定3. Callers
 * that apply their own upper bound must not assume it shares this
 * convention — check the caller's own contract before pushing a filter down
 * into this query (Issue #230).
 */
export function listEventsSince(
  db: Database.Database,
  isoTime: string,
  untilIsoExclusive?: string,
): ActivityEvent[] {
  let sql = "SELECT * FROM activity_events WHERE created_at >= ?";
  const params: string[] = [isoTime];

  if (untilIsoExclusive !== undefined) {
    sql += " AND created_at < ?";
    params.push(untilIsoExclusive);
  }

  sql += " ORDER BY created_at ASC, id ASC";

  return db.prepare(sql).all(...params) as ActivityEvent[];
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

/**
 * Returns the most recent `task_start` or `task_pause` event for `taskId`
 * (by `created_at`, with `id` as a tie-breaker), or `undefined` if none
 * exists yet. `task_update` (board-operation-originated) is intentionally
 * excluded from this comparison — see docs/features/backdated-checkin.md
 * 判断4/仮定2.
 *
 * Used by `checkins-routes.ts` (Issue #350) to decide whether a backdated
 * `task_start`/`task_pause` (an `occurred_at` older/newer than this event)
 * should still transition `tasks.status`.
 */
export function findLatestTaskStartOrPauseEvent(
  db: Database.Database,
  taskId: number,
): ActivityEvent | undefined {
  return db
    .prepare(
      `SELECT * FROM activity_events
       WHERE task_id = ? AND type IN ('task_start', 'task_pause')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(taskId) as ActivityEvent | undefined;
}

export type BreakEndOrderCheck =
  | { valid: true }
  | {
      valid: false;
      reason: "no_prior_break_start" | "already_closed" | "same_as_break_start";
    };

/**
 * Checks whether a `break_end` backdated to `occurredAt` (already normalized
 * to `toISOString()` form by the caller) is orderable against existing
 * events: there must be a `break_start` strictly before `occurredAt` with no
 * `break_end` already recorded between that `break_start` and `occurredAt`.
 *
 * Deliberately keys off the `break_start` immediately *before* `occurredAt`
 * (not the globally-latest `break_start`) — docs/features/backdated-checkin.md
 * 判断5 rejects the "latest break_start" alternative because it would wrongly
 * reject a valid backdated `break_end` when a later break has already been
 * recorded (see AC-8).
 */
export function checkBreakEndOrder(
  db: Database.Database,
  occurredAt: string,
): BreakEndOrderCheck {
  const sameTimeBreakStart = db
    .prepare(
      "SELECT 1 FROM activity_events WHERE type = 'break_start' AND created_at = ? LIMIT 1",
    )
    .get(occurredAt);
  if (sameTimeBreakStart !== undefined) {
    // getActiveBreak (detection/break-overrun.ts) only closes a break with a
    // break_end strictly *after* break_start, so an exactly-simultaneous
    // break_end would not actually close the break it targets.
    return { valid: false, reason: "same_as_break_start" };
  }

  const priorBreakStart = db
    .prepare(
      `SELECT * FROM activity_events WHERE type = 'break_start' AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(occurredAt) as ActivityEvent | undefined;
  if (!priorBreakStart) {
    return { valid: false, reason: "no_prior_break_start" };
  }

  const alreadyClosed = db
    .prepare(
      `SELECT 1 FROM activity_events
       WHERE type = 'break_end' AND created_at > ? AND created_at < ? LIMIT 1`,
    )
    .get(priorBreakStart.created_at, occurredAt);
  if (alreadyClosed !== undefined) {
    return { valid: false, reason: "already_closed" };
  }

  return { valid: true };
}
