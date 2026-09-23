// The local-calendar-day boundary module for the server (ADR 0007 決定3).
// Dependency-free on purpose (no Hono, no other feature directories) so every
// layer that needs a "local day" range can share one definition without
// importing across features: the HTTP route layer (activity-routes.ts), the
// boss tool layer (boss/activity-log-tool.ts, Issue #150) and the report
// collectors (reports/collect-*-data.ts, Issue #172). It lives under
// activity/ for historical reasons (`startOfLocalDayIso` started out in
// activity-routes.ts and moved here when the boss tool layer needed it), not
// because the policy is activity-specific. It is a feature-independent leaf
// module that every feature imports (activity-routes, boss, reports,
// dashboard). Since #236 it is the only server-side implementation of the
// half-open local-day *range* boundaries (the last duplicate, in
// dashboard/today-escalation.ts, was folded in); date-key parsing/formatting
// (`YYYY-MM-DD`) is a separate concern in detection/time-utils.ts (ADR 0007
// 決定2).

/**
 * Start of the local day containing `date` as an ISO string. `date` defaults
 * to the current time; local (not UTC) year/month/date are used per the app's
 * "today starts at local midnight" convention.
 *
 * This is the *inclusive* lower bound of ADR 0007 決定3's half-open range.
 * Callers that also need the upper bound must derive both from the same
 * `date` value — see `startOfNextLocalDayIso`.
 */
export function startOfLocalDayIso(date: Date = new Date()): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

/**
 * Start of the local day *after* `date`, as an ISO string — the *exclusive*
 * upper bound pairing with `startOfLocalDayIso` to express a single-local-day
 * window (Issue #230: `GET /api/activity/today` returning events beyond
 * midnight when the clock/timezone is turned back, or a future-dated row
 * already exists).
 *
 * `date` is deliberately **required** (unlike `startOfLocalDayIso`, which has
 * a standalone "since start of today" use in boss/activity-log-tool.ts). An
 * upper bound is only ever meaningful next to a lower bound, and letting each
 * default to its own `new Date()` would let the pair straddle local midnight
 * — widening the window to two days or, on a clock rollback, collapsing it to
 * empty. Requiring the argument makes callers pass one shared clock read.
 *
 * The next-day boundary is computed by advancing the local calendar date by
 * one (`new Date(y, m, d + 1)`), not by adding a fixed 24h/86400000ms
 * offset: in timezones observing DST, a calendar day can be 23 or 25 hours
 * long, so a fixed-duration add would land on the wrong local time on
 * transition days. `Date`'s constructor normalizes an out-of-range day
 * (e.g. day 32 in a 31-day month) into the correct next month, so this
 * works across month/year boundaries too.
 */
export function startOfNextLocalDayIso(date: Date): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).toISOString();
}
