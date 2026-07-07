/**
 * Response shape for `GET /api/dashboard` (Issue #58). Aggregates today's
 * progress, morning/evening session status, the day's highest escalation
 * level, and the boss's cached one-liner comment — everything the dashboard
 * screen (and the avatar expression logic, a separate ticket) needs in one
 * response.
 */

export interface DashboardProgress {
  /** Number of target tasks completed today. */
  done: number;
  /** Number of target tasks (today's done + current todo/in_progress). */
  total: number;
  /** `done / total`, or 0 when `total` is 0. */
  ratio: number;
}

export interface DashboardResponse {
  progress: DashboardProgress;
  morningSessionHeld: boolean;
  eveningSessionHeld: boolean;
  todayMaxEscalationLevel: number;
  bossComment: string;
  /** Local date (`YYYY-MM-DD`) the response was computed for. */
  date: string;
}
