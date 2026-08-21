import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { findTaskById, updateTask } from "../tasks/tasks-repository.js";
import { recordActivityEvent } from "./activity-events-repository.js";
import { validateCheckinInput } from "./checkins-validation.js";

/**
 * Creates the checkins sub-router, mounted under `/api/checkins` by the
 * caller. Handles the single explicit-checkin endpoint
 * (`POST /api/checkins`).
 */
export function createCheckinsRouter(db: Database.Database): Hono {
  const checkins = new Hono();

  checkins.post("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validateCheckinInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    // Checked for any type, not just task_start/task_pause: activity_events.
    // task_id has a foreign key constraint, so an unchecked non-existent id
    // would surface as an unhandled 500 (SQLITE_CONSTRAINT_FOREIGNKEY)
    // instead of a 404.
    let taskTransition: { taskId: number; status: "in_progress" | "paused" } | null =
      null;
    if (result.data.task_id !== null) {
      const task = findTaskById(db, result.data.task_id);
      if (!task) {
        return c.json({ error: `task ${result.data.task_id} not found` }, 404);
      }
      // "Starting" a task only transitions it out of todo or paused, and
      // "pausing" a task only transitions it out of in_progress. Every
      // other source status for that checkin type (including no-ops like
      // task_start on an already in_progress task, or task_pause on an
      // already paused one) stays untouched (see #133, #179).
      if (
        result.data.type === "task_start" &&
        (task.status === "todo" || task.status === "paused")
      ) {
        taskTransition = { taskId: task.id, status: "in_progress" };
      } else if (
        result.data.type === "task_pause" &&
        task.status === "in_progress"
      ) {
        taskTransition = { taskId: task.id, status: "paused" };
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
      const recorded = recordActivityEvent(db, result.data);
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
