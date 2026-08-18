import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listEventsSince } from "./activity-events-repository.js";
import { startOfLocalDayIso } from "./local-day.js";

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
    return c.json(listEventsSince(db, startOfLocalDayIso()));
  });

  return activity;
}
