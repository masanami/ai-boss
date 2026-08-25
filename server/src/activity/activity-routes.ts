import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listEventsSince } from "./activity-events-repository.js";
import { startOfLocalDayIso, startOfNextLocalDayIso } from "./local-day.js";

// `startOfLocalDayIso` lives in `./local-day.js` (dependency-free) rather
// than here so `boss/activity-log-tool.ts` (Issue #150) can reuse the exact
// same "today" boundary without importing this HTTP route module (self-
// review: a tool-layer -> route-layer import would be a layering issue).

/**
 * Creates the activity sub-router, mounted under `/api/activity` by the
 * caller. Handles `GET /api/activity/today`.
 */
export function createActivityRouter(db: Database.Database): Hono {
  const activity = new Hono();

  activity.get("/today", (c) => {
    // Both boundaries must come from the same clock read: calling
    // startOfLocalDayIso() and startOfNextLocalDayIso() independently (each
    // defaulting to its own `new Date()`) risks the pair landing on
    // different local days if evaluation straddles local midnight — either
    // widening the window to two days (recreating the #230 leak) or, on a
    // clock/timezone rollback, collapsing it to empty (self-review: code-
    // reviewer and design-reviewer both independently flagged this).
    const now = new Date();
    return c.json(listEventsSince(db, startOfLocalDayIso(now), startOfNextLocalDayIso(now)));
  });

  return activity;
}
