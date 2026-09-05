import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { findTaskById, updateTask } from "../tasks/tasks-repository.js";
import type { TaskStatus } from "../tasks/task.js";
import {
  checkBreakEndOrder,
  findLatestTaskStartOrPauseEvent,
  recordActivityEvent,
} from "./activity-events-repository.js";
import { startOfLocalDayIso } from "./local-day.js";
import { validateCheckinInput } from "./checkins-validation.js";

const BREAK_END_ORDER_ERROR_MESSAGES: Record<
  "no_prior_break_start" | "already_closed" | "same_as_break_start",
  string
> = {
  no_prior_break_start:
    "occurred_at must be after the most recent break_start",
  already_closed:
    "the break starting before occurred_at has already been ended",
  same_as_break_start:
    "occurred_at must be strictly after the most recent break_start",
};

/**
 * Whether a backdated task_start/task_pause at `occurredAt` (already
 * normalized to `toISOString()` form) is newer than the task's most recent
 * task_start/task_pause event — the transition-eligibility rule from
 * docs/features/backdated-checkin.md 判断4. A task with no prior
 * task_start/task_pause event is always "newer" (nothing to compare
 * against).
 */
function isNewerThanLatestTransition(
  db: Database.Database,
  taskId: number,
  occurredAt: string,
): boolean {
  const latest = findLatestTaskStartOrPauseEvent(db, taskId);
  if (!latest) {
    return true;
  }
  return occurredAt > latest.created_at;
}

/**
 * Creates the checkins sub-router, mounted under `/api/checkins` by the
 * caller. Handles the single explicit-checkin endpoint
 * (`POST /api/checkins`).
 */
export function createCheckinsRouter(db: Database.Database): Hono {
  const checkins = new Hono();

  checkins.post("/", async (c) => {
    // Read once, up front: both the future-time check and the local-day
    // boundary check below must derive from the same clock read (Issue #350,
    // mirroring GET /api/activity/today's "one clock read for both
    // boundaries" discipline).
    const now = new Date();
    const body = await readJsonBody(c);

    const result = validateCheckinInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    // Checked for any type, not just task_start/task_pause: activity_events.
    // task_id has a foreign key constraint, so an unchecked non-existent id
    // would surface as an unhandled 500 (SQLITE_CONSTRAINT_FOREIGNKEY)
    // instead of a 404.
    let taskStatus: TaskStatus | null = null;
    if (result.data.task_id !== null) {
      const task = findTaskById(db, result.data.task_id);
      if (!task) {
        return c.json({ error: `task ${result.data.task_id} not found` }, 404);
      }
      taskStatus = task.status;
    }

    // occurred_at (Issue #350, docs/features/backdated-checkin.md 判断5):
    // shape was already validated by validateCheckinInput (400). Here we
    // normalize to Z-form immediately and run the DB/clock-aware integrity
    // checks against that normalized value only — never the raw input
    // string — because listEventsSince and friends range-filter created_at
    // with plain SQL string comparison, which breaks if an offset-bearing
    // string were ever stored or compared.
    let occurredAt: string | null = null;
    if (result.data.occurred_at !== null) {
      occurredAt = new Date(result.data.occurred_at).toISOString();

      if (occurredAt > now.toISOString()) {
        return c.json({ error: "occurred_at must not be in the future" }, 400);
      }

      if (occurredAt < startOfLocalDayIso(now)) {
        return c.json(
          { error: "occurred_at must not be before the start of today" },
          400,
        );
      }

      if (result.data.type === "break_end") {
        const check = checkBreakEndOrder(db, occurredAt);
        if (!check.valid) {
          return c.json({ error: BREAK_END_ORDER_ERROR_MESSAGES[check.reason] }, 400);
        }
      }
    }

    // "Starting" a task only transitions it out of todo or paused, and
    // "pausing" a task only transitions it out of in_progress. Every
    // other source status for that checkin type (including no-ops like
    // task_start on an already in_progress task, or task_pause on an
    // already paused one) stays untouched (see #133, #179). When
    // occurred_at is given (backdated), the transition additionally
    // requires that occurred_at be strictly newer than the task's latest
    // task_start/task_pause event (判断4) — otherwise the event is recorded
    // but the status is left as-is (AC-10, AC-12). occurred_at omitted
    // keeps the existing unconditional-transition contract (仮定3).
    let taskTransition: { taskId: number; status: "in_progress" | "paused" } | null =
      null;
    if (result.data.task_id !== null && taskStatus !== null) {
      const taskId = result.data.task_id;
      if (result.data.type === "task_start" && (taskStatus === "todo" || taskStatus === "paused")) {
        if (occurredAt === null || isNewerThanLatestTransition(db, taskId, occurredAt)) {
          taskTransition = { taskId, status: "in_progress" };
        }
      } else if (result.data.type === "task_pause" && taskStatus === "in_progress") {
        if (occurredAt === null || isNewerThanLatestTransition(db, taskId, occurredAt)) {
          taskTransition = { taskId, status: "paused" };
        }
      }
    }

    // Always run inside a transaction (a no-op wrapper when there is no
    // status transition to make) so the event-only path and the
    // event + status-transition path share one code shape. When
    // taskTransition is set, updateTask + recordActivityEvent are wrapped in
    // the same transaction so the checkin event and the status transition
    // never diverge (#133): if updateTask throws, the event insert above it
    // is rolled back too (verified directly by checkins-routes.test.ts's
    // "rolls back the task_start/task_pause event when the status update
    // fails" tests). updateTask itself opens a nested db.transaction() to
    // record its own task_update event; better-sqlite3 treats that nesting
    // as a SAVEPOINT, so it composes safely with this outer transaction —
    // exercised by the happy-path "transitions a todo task to in_progress"
    // and "transitions an in_progress task to paused" tests, which each
    // assert both events land.
    const recordCheckin = db.transaction(() => {
      const recorded = recordActivityEvent(db, {
        type: result.data.type,
        task_id: result.data.task_id,
        note: result.data.note,
        expected_minutes: result.data.expected_minutes,
        created_at: occurredAt ?? undefined,
      });
      if (taskTransition !== null) {
        // taskTransition only ever comes from a task looked up by
        // findTaskById just above (existence already confirmed as a 404
        // check), and this whole handler runs synchronously up to this
        // point (no `await` in between) — so update is only skipped if the
        // task's status genuinely doesn't match the expected source status,
        // never a missed row.
        updateTask(db, taskTransition.taskId, { status: taskTransition.status });
      }
      return recorded;
    });
    const event = recordCheckin();
    return c.json(event, 201);
  });

  return checkins;
}
