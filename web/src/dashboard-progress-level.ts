import {
  ENCOURAGING_RATIO_THRESHOLD,
  SATISFIED_RATIO_THRESHOLD,
} from "./boss-expression";

export type ProgressLevel = "low" | "mid" | "high";

/**
 * Classifies a progress ratio into a 3-tier level used to color the progress
 * gauge (低: 抑えた色 → 高: 暖色アクセント, per the ticket). Explicit
 * assumption: reuses the same cutoffs as `resolveBossExpression` (Issue #59)
 * so the gauge color and the boss's mood stay consistent with each other.
 */
export function resolveProgressLevel(ratio: number): ProgressLevel {
  if (ratio < ENCOURAGING_RATIO_THRESHOLD) {
    return "low";
  }
  if (ratio >= SATISFIED_RATIO_THRESHOLD) {
    return "high";
  }
  return "mid";
}
