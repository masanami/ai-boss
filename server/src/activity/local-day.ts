// Dependency-free on purpose (no Hono, no other feature directories) so both
// the HTTP route layer (activity-routes.ts) and the boss tool layer
// (boss/activity-log-tool.ts, Issue #150) can share one "local day" boundary
// definition without the tool layer importing an HTTP route module (a
// layering issue self-review caught when `startOfLocalDayIso` briefly lived
// in activity-routes.ts and get_activity_log imported it from there).

/**
 * Start of the current local day as an ISO string. `now` defaults to the
 * current time; local (not UTC) year/month/date are used per the app's
 * "today starts at local midnight" convention.
 */
export function startOfLocalDayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/**
 * Start of the local day *after* `now`, as an ISO string — the exclusive
 * upper bound pairing with `startOfLocalDayIso` to express a "today only"
 * window (Issue #230: `GET /api/activity/today` returning events beyond
 * midnight when the clock/timezone is turned back, or a future-dated row
 * already exists).
 *
 * The next-day boundary is computed by advancing the local calendar date by
 * one (`new Date(y, m, d + 1)`), not by adding a fixed 24h/86400000ms
 * offset: in timezones observing DST, a calendar day can be 23 or 25 hours
 * long, so a fixed-duration add would land on the wrong local time on
 * transition days. `Date`'s constructor normalizes an out-of-range day
 * (e.g. day 32 in a 31-day month) into the correct next month, so this
 * works across month/year boundaries too.
 */
export function startOfNextLocalDayIso(now: Date = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
}
