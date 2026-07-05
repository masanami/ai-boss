import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listEventsSince } from "./activity-events-repository.js";

/**
 * Start of the current local day as an ISO string. `now` defaults to the
 * current time; local (not UTC) year/month/date are used per the ticket's
 * explicit assumption that "today" starts at the server's local midnight.
 */
function startOfLocalDayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

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
