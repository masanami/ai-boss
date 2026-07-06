export type BossExpression = "normal" | "satisfied" | "displeased" | "encouraging";

/**
 * resolveBossExpression の入力。GET /api/dashboard（#58）のレスポンスから
 * 必要なフィールドだけを抜き出したフラットな独自型（API 型に依存させない）。
 */
export interface BossExpressionContext {
  progressRatio: number;
  morningSessionHeld: boolean;
  eveningSessionHeld: boolean;
  todayMaxEscalationLevel: number;
}

const ESCALATION_DISPLEASED_THRESHOLD = 2;
const SATISFIED_RATIO_THRESHOLD = 0.8;
const EVENING_DISPLEASED_RATIO_THRESHOLD = 0.5;
const ENCOURAGING_RATIO_THRESHOLD = 0.3;

/**
 * 文脈からボスの表情を決める純粋関数。優先順位（Issue #59 の明示的な仮定）:
 * 1. エスカレーションレベル >= 2 → displeased
 * 2. 夕会済みかつ達成率 >= 0.8 → satisfied
 * 3. 夕会済みかつ達成率 < 0.5 → displeased
 * 4. 達成率 >= 0.8 → satisfied
 * 5. 朝会済みかつ達成率 < 0.3 → encouraging
 * 6. それ以外 → normal
 */
export function resolveBossExpression(
  context: BossExpressionContext,
): BossExpression {
  const {
    progressRatio,
    morningSessionHeld,
    eveningSessionHeld,
    todayMaxEscalationLevel,
  } = context;

  if (todayMaxEscalationLevel >= ESCALATION_DISPLEASED_THRESHOLD) {
    return "displeased";
  }
  // ルール4（達成率 >= 0.8 → satisfied）に完全に包含されるため実行上は冗長だが、
  // Issue #59 が明示する優先順位リストとの1対1対応を保ちトレーサビリティを優先する。
  if (eveningSessionHeld && progressRatio >= SATISFIED_RATIO_THRESHOLD) {
    return "satisfied";
  }
  if (eveningSessionHeld && progressRatio < EVENING_DISPLEASED_RATIO_THRESHOLD) {
    return "displeased";
  }
  if (progressRatio >= SATISFIED_RATIO_THRESHOLD) {
    return "satisfied";
  }
  if (morningSessionHeld && progressRatio < ENCOURAGING_RATIO_THRESHOLD) {
    return "encouraging";
  }
  return "normal";
}
