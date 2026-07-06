import type { BossExpressionContext } from "./boss-expression";
import type { DashboardResponse } from "./dashboard-response";

/**
 * Converts a `GET /api/dashboard` response into the flat context
 * `resolveBossExpression` (Issue #59) expects. Kept as the single place this
 * mapping happens, per the ticket's explicit requirement.
 */
export function toBossExpressionContext(
  dashboard: DashboardResponse,
): BossExpressionContext {
  return {
    progressRatio: dashboard.progress.ratio,
    morningSessionHeld: dashboard.morningSessionHeld,
    eveningSessionHeld: dashboard.eveningSessionHeld,
    todayMaxEscalationLevel: dashboard.todayMaxEscalationLevel,
  };
}
