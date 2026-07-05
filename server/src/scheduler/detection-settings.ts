import type Database from "better-sqlite3";
import { getSettingValue } from "../settings/settings-repository.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  type DetectionSettings,
} from "../detection/detection-types.js";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function resolveTimeSetting(db: Database.Database, key: string, fallback: string): string {
  const value = getSettingValue(db, key);
  if (value === undefined) return fallback;
  if (TIME_PATTERN.test(value)) return value;

  console.warn(
    `settings.${key} の値 "${value}" は "HH:mm" 形式ではありません。既定値 ${fallback} を使用します。`,
  );
  return fallback;
}

function resolvePositiveIntSetting(db: Database.Database, key: string, fallback: number): number {
  const value = getSettingValue(db, key);
  if (value === undefined) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0 && String(parsed) === value.trim()) {
    return parsed;
  }

  console.warn(
    `settings.${key} の値 "${value}" は正の整数ではありません。既定値 ${fallback} を使用します。`,
  );
  return fallback;
}

/**
 * Reads detection settings (working hours / meeting times / fallback
 * thresholds / escalation intervals) from the `settings` key-value table,
 * falling back to `DEFAULT_DETECTION_SETTINGS` for any key that is missing
 * or holds an invalid value. Settings keys and defaults follow Issue #38's
 * explicit assumptions.
 *
 * `scale` / `min` / `max` (per-rule threshold scaling) and
 * `avoidanceWindowMinutes` are intentionally left at the engine's built-in
 * defaults: Issue #38 does not define settings keys for them (only the
 * fallback minutes are settings-backed), so overriding them here would be
 * speculative (YAGNI) — add settings keys if/when the settings screen
 * (Issue #8) needs to expose them.
 */
export function loadDetectionSettings(db: Database.Database): DetectionSettings {
  const base = DEFAULT_DETECTION_SETTINGS;

  return {
    ...base,
    workingHours: {
      start: resolveTimeSetting(db, "work_start", base.workingHours.start),
      end: resolveTimeSetting(db, "work_end", base.workingHours.end),
    },
    unstarted: {
      ...base.unstarted,
      fallback: resolvePositiveIntSetting(
        db,
        "detection_unstarted_fallback_minutes",
        base.unstarted.fallback,
      ),
    },
    silence: {
      ...base.silence,
      fallback: resolvePositiveIntSetting(
        db,
        "detection_silence_fallback_minutes",
        base.silence.fallback,
      ),
    },
    breakFallbackMinutes: resolvePositiveIntSetting(
      db,
      "detection_break_fallback_minutes",
      base.breakFallbackMinutes,
    ),
    escalation: {
      level1ToLevel2Minutes: resolvePositiveIntSetting(
        db,
        "escalation_l2_after_minutes",
        base.escalation.level1ToLevel2Minutes,
      ),
      level2ToLevel3Minutes: resolvePositiveIntSetting(
        db,
        "escalation_l3_after_minutes",
        base.escalation.level2ToLevel3Minutes,
      ),
      level3RepeatMinutes: resolvePositiveIntSetting(
        db,
        "escalation_repeat_minutes",
        base.escalation.level3RepeatMinutes,
      ),
    },
    morningMeetingTime: resolveTimeSetting(db, "morning_meeting_time", base.morningMeetingTime),
    eveningMeetingTime: resolveTimeSetting(db, "evening_meeting_time", base.eveningMeetingTime),
  };
}
