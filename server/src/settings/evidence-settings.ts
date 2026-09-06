import type Database from "better-sqlite3";
import { getSettingValue } from "./settings-repository.js";

export interface EvidenceSettings {
  /**
   * Whether the evidence-required gate on task completion is active
   * (`evidence_enforcement_enabled` setting). Defaults to `false` when the
   * key has never been set (機能仕様
   * docs/features/completion-evidence-enforcement.md 決定 7: キー未設定時の
   * 既定は OFF）。An unrecognized stored value (anything other than the
   * literal string `"true"`) is also treated as `false`, the same
   * fail-closed-to-default posture `boss-settings.ts` / `detection-settings.ts`
   * take for other settings.
   */
  enforcementEnabled: boolean;
}

/**
 * Reads the evidence-enforcement settings from the `settings` key-value
 * table. This is the single reader both `GET /api/settings`
 * (`settings-routes.ts`'s `readEffectiveSettings`) and the completion gate
 * (a later ticket's `updateTask` change) must call, so the two can never
 * drift apart (決定 7-b: 同じ reader を読む).
 */
export function resolveEvidenceSettings(db: Database.Database): EvidenceSettings {
  return {
    enforcementEnabled: getSettingValue(db, "evidence_enforcement_enabled") === "true",
  };
}
