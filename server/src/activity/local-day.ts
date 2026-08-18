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
