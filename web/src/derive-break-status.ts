import type { ActivityEvent } from "./activity-event";

/**
 * Derives whether the user is currently on a break from today's activity
 * events (ascending by `created_at`, per `GET /api/activity/today`). There is
 * no dedicated "current status" endpoint (see ticket #39's explicit
 * assumption): a `break_start` with no later `break_end` means on-break.
 */
export function deriveIsOnBreak(events: ActivityEvent[]): boolean {
  return events.reduce((onBreak, event) => {
    if (event.type === "break_start") {
      return true;
    }
    if (event.type === "break_end") {
      return false;
    }
    return onBreak;
  }, false);
}
