// web/src/boss-expression.ts / dashboard-progress-level.ts / evening-evaluation.ts の移植。
enum BossExpression { normal, satisfied, displeased, encouraging }

class BossExpressionContext {
  const BossExpressionContext({
    required this.progressRatio,
    required this.morningSessionHeld,
    required this.eveningSessionHeld,
    required this.todayMaxEscalationLevel,
  });
  final double progressRatio;
  final bool morningSessionHeld;
  final bool eveningSessionHeld;
  final int todayMaxEscalationLevel;
}

const escalationDispleasedThreshold = 2;
const satisfiedRatioThreshold = 0.8;
const eveningDispleasedRatioThreshold = 0.5;
const encouragingRatioThreshold = 0.3;

BossExpression resolveBossExpression(BossExpressionContext c) {
  if (c.todayMaxEscalationLevel >= escalationDispleasedThreshold) return BossExpression.displeased;
  if (c.eveningSessionHeld && c.progressRatio >= satisfiedRatioThreshold) return BossExpression.satisfied;
  if (c.eveningSessionHeld && c.progressRatio < eveningDispleasedRatioThreshold) return BossExpression.displeased;
  if (c.progressRatio >= satisfiedRatioThreshold) return BossExpression.satisfied;
  if (c.morningSessionHeld && c.progressRatio < encouragingRatioThreshold) return BossExpression.encouraging;
  return BossExpression.normal;
}

enum ProgressLevel { low, mid, high }

ProgressLevel resolveProgressLevel(double ratio) {
  if (ratio < encouragingRatioThreshold) return ProgressLevel.low;
  if (ratio >= satisfiedRatioThreshold) return ProgressLevel.high;
  return ProgressLevel.mid;
}

enum EveningEvaluationTone { praise, scold, neutral }

EveningEvaluationTone resolveEveningEvaluationTone(double ratio) {
  if (ratio >= satisfiedRatioThreshold) return EveningEvaluationTone.praise;
  if (ratio < eveningDispleasedRatioThreshold) return EveningEvaluationTone.scold;
  return EveningEvaluationTone.neutral;
}
