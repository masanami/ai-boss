import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listEventsSince } from "./activity-events-repository.js";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "./local-day.js";

// The local-day boundary helpers live in `./local-day.js` (dependency-free)
// rather than here, so every other layer can reuse the exact same "today"
// boundary without importing this HTTP route module. See that file's header
// for the rationale — it is not repeated here.

/**
 * Creates the activity sub-router, mounted under `/api/activity` by the
 * caller. Handles `GET /api/activity/today`.
 */
export function createActivityRouter(db: Database.Database): Hono {
  const activity = new Hono();

  activity.get("/today", (c) => {
    // Both boundaries must come from the same clock read: deriving them from
    // two separate `new Date()` calls risks the pair landing on different
    // local days if evaluation straddles local midnight — either widening
    // the window to two days (recreating the #230 leak) or, on a clock/
    // timezone rollback, collapsing it to empty.
    //
    // `startOfNextLocalDayIso` requires its argument, which rules out the
    // "both sides default to their own `new Date()`" form. It does *not*
    // make the mistake impossible — `startOfLocalDayIso()` still defaults,
    // so a mixed call would still type-check. Keep passing one shared `now`.
    const now = new Date();
    return c.json(listEventsSince(db, startOfLocalDayIso(now), startOfNextLocalDayIso(now)));
  });

  return activity;
}
