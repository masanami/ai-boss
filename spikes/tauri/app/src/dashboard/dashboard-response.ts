/**
 * Frontend-local mirror of the `GET /api/dashboard` response shape
 * (`server/src/dashboard/dashboard.ts`, Issue #58). Kept as a separate type
 * (rather than importing the server module) to match the existing pattern of
 * `task.ts` / `decision.ts`, which mirror their respective server shapes.
 */

export interface DashboardProgress {
  /** Number of target tasks completed today. */
  done: number;
  /** Number of target tasks (today's done + current todo/in_progress/paused). */
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
