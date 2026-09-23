import {
  EVENING_DISPLEASED_RATIO_THRESHOLD,
  SATISFIED_RATIO_THRESHOLD,
} from "./boss-expression";

export type EveningEvaluationTone = "praise" | "scold" | "neutral";

/**
 * Decides the visual tone of the evening-session evaluation panel from the
 * progress ratio. Explicit assumption (per the ticket): reuses the same
 * cutoffs as `resolveBossExpression`'s evening rules (Issue #59) — ratio
 * >= 0.8 is praise, < 0.5 is scold, otherwise neutral.
 */
export function resolveEveningEvaluationTone(
  ratio: number,
): EveningEvaluationTone {
  if (ratio >= SATISFIED_RATIO_THRESHOLD) {
    return "praise";
  }
  if (ratio < EVENING_DISPLEASED_RATIO_THRESHOLD) {
    return "scold";
  }
  return "neutral";
}
