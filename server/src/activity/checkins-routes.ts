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

    // Checked for any type, not just task_start: activity_events.task_id has
    // a foreign key constraint, so an unchecked non-existent id would surface
    // as an unhandled 500 (SQLITE_CONSTRAINT_FOREIGNKEY) instead of a 404.
    let taskIdToStart: number | null = null;
    if (result.data.task_id !== null) {
      const task = findTaskById(db, result.data.task_id);
      if (!task) {
        return c.json({ error: `task ${result.data.task_id} not found` }, 404);
      }
      // Only a todo -> in_progress transition happens as a side effect of
      // "starting" a task. in_progress/done tasks stay untouched (see #133).
      if (result.data.type === "task_start" && task.status === "todo") {
        taskIdToStart = task.id;
      }
    }

    // Always run inside a transaction (a no-op wrapper when there is no
    // status transition to make) so the task_start-only path and the
    // task_start + status-transition path share one code shape. When
    // taskIdToStart is set, updateTask + recordActivityEvent are wrapped in
    // the same transaction so the task_start event and the todo ->
    // in_progress transition never diverge (#133): if updateTask throws,
    // the event insert above it is rolled back too (verified directly by
    // checkins-routes.test.ts's "rolls back the task_start event when the
    // status update fails" test). updateTask itself opens a nested
    // db.transaction() to record its own task_update event; better-sqlite3
    // treats that nesting as a SAVEPOINT, so it composes safely with this
    // outer transaction — exercised by the happy-path "transitions a todo
    // task to in_progress" test, which asserts both events land.
    const recordCheckin = db.transaction(() => {
      const recorded = recordActivityEvent(db, result.data);
      if (taskIdToStart !== null) {
        // taskIdToStart only ever comes from a task looked up by
        // findTaskById just above (existence already confirmed as a 404
        // check), and this whole handler runs synchronously up to this
        // point (no `await` in between) — so update is only skipped if the
        // task's status genuinely isn't "todo", never a missed row.
        updateTask(db, taskIdToStart, { status: "in_progress" });
      }
      return recorded;
    });
    const event = recordCheckin();
    return c.json(event, 201);
  });

  return checkins;
}
