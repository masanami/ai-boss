import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { findTaskById } from "../tasks/tasks-repository.js";
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
    if (result.data.task_id !== null) {
      const task = findTaskById(db, result.data.task_id);
      if (!task) {
        return c.json({ error: `task ${result.data.task_id} not found` }, 404);
      }
    }

    const event = recordActivityEvent(db, result.data);
    return c.json(event, 201);
  });

  return checkins;
}
