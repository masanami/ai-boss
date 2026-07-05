import type { DetectionRuleType } from "../detection/detection-types.js";
import type { EscalationLevel, RuleType } from "../notifications/notification-body.js";

/**
 * Maps the detection engine's rule types (Issue #36) to the notification
 * body generator's rule types (Issue #37). The two modules were implemented
 * in parallel from a shared base and drifted slightly in naming
 * (`unstarted` vs `todo_stall`); `deadline_overdue` / `morning_meeting` /
 * `evening_meeting` did not exist yet on the notification-body side. This
 * mapping, together with a small additive extension to
 * `notification-body.ts`'s `RULE_TYPES` (new entries only, no renames),
 * reconciles the two without reworking either module (see PR description
 * for #38).
 */
const RULE_TYPE_MAP: Record<DetectionRuleType, RuleType> = {
  unstarted: "todo_stall",
  avoidance: "avoidance",
  break_overrun: "break_overrun",
  silence: "silence",
  deadline_overdue: "deadline_overdue",
  morning_meeting: "morning_meeting",
  evening_meeting: "evening_meeting",
};

export function mapToNotificationRuleType(ruleType: DetectionRuleType): RuleType {
  return RULE_TYPE_MAP[ruleType];
}

const MIN_ESCALATION_LEVEL = 1;
const MAX_ESCALATION_LEVEL = 3;

/**
 * Clamps the rule engine's `escalationLevel` (already 1-3 by construction —
 * see `detection/escalation.ts`'s `MAX_ESCALATION_LEVEL`) into the
 * `EscalationLevel` literal type. Defensive only: mirrors the same posture
 * `notification-body.ts` already takes for out-of-range values.
 */
export function toEscalationLevel(level: number): EscalationLevel {
  const clamped = Math.min(
    Math.max(Math.round(level), MIN_ESCALATION_LEVEL),
    MAX_ESCALATION_LEVEL,
  );
  return clamped as EscalationLevel;
}
