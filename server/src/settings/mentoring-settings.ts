import type Database from "better-sqlite3";
import { getSettingValue } from "./settings-repository.js";

/**
 * Reads the `morning_mentoring_required` setting from the `settings`
 * key-value table.
 *
 * Unlike `resolveEvidenceSettings` (default OFF for unset/invalid), this
 * key defaults to **ON**: the key being unset, or holding any stored value
 * other than the literal string `"false"` (e.g. an unrecognized value such
 * as `"yes"`), resolves to `true`. This is the safe-by-default posture
 * required by 機能仕様 docs/features/work-approach-mentoring.md 判断7 — a
 * broken stored value must not silently disable the enforcement gate.
 *
 * This is the single reader both `GET /api/settings`
 * (`settings-routes.ts`'s `readEffectiveSettings`) and the morning-session
 * end gate (a later ticket's `mentoring-gate.ts` wiring) must call, so the
 * two can never drift apart (同型の一貫性を `evidence-settings.ts` に揃える).
 */
export function resolveMorningMentoringRequired(db: Database.Database): boolean {
  return getSettingValue(db, "morning_mentoring_required") !== "false";
}
