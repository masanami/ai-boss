import type Database from "better-sqlite3";
import { getSettingValue } from "../settings/settings-repository.js";
import { isValidWorkingHoursRange } from "../settings/settings-validation.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  TIME_PATTERN,
  type DetectionSettings,
  type WorkingHours,
} from "../detection/detection-types.js";

function resolveTimeSetting(db: Database.Database, key: string, fallback: string): string {
  const value = getSettingValue(db, key);
  if (value === undefined) return fallback;
  if (TIME_PATTERN.test(value)) return value;

  console.warn(
    `settings.${key} の値 "${value}" は "HH:mm" 形式ではありません。既定値 ${fallback} を使用します。`,
  );
  return fallback;
}

/**
 * `work_start` / `work_end` を読み、書式検証（`resolveTimeSetting`）の
 * 後段で相関（`work_start < work_end`）も検査する読み出し側ガード
 * （親要件 #448 決定1・2、#482）。
 *
 * 書き込み側（#480/#481）は `PUT /api/settings` を経由する限り不正な組を
 * 弾くが、`settings` テーブルへ直接書かれた既存の不正値までは救えない。
 * `isWithinWorkingHours`（`detection/time-utils.ts`）の安全網は
 * `timeStringToMinutes` が `null` を返す＝書式が壊れているときにしか
 * 効かず、`22:00`/`02:00` のように書式としては正当な不正相関はこの安全網
 * を素通りしてしまう（Issue #482 の「発見①」）ため、この関数がその入口を
 * 塞ぐ。
 *
 * 相関が不正なときは `work_start` / `work_end` を**組として**既定へ倒す
 * （例えば `end` だけを既定に差し替えると `22:00`-`18:00` のようにまだ
 * 不正な組が残ってしまうため）。`isValidWorkingHoursRange` は形式不正な
 * 入力に対して fail-open（`true`）だが、ここに渡す値は既に
 * `resolveTimeSetting` を通しているため書式は保証されている。
 */
function resolveWorkingHours(db: Database.Database, base: WorkingHours): WorkingHours {
  const start = resolveTimeSetting(db, "work_start", base.start);
  const end = resolveTimeSetting(db, "work_end", base.end);

  if (isValidWorkingHoursRange(start, end)) {
    return { start, end };
  }

  console.warn(
    `settings.work_start / settings.work_end の組み合わせ ("${start}" - "${end}") は開始時刻が終了時刻以降になっており不正です。既定の勤務時間帯 ${base.start}-${base.end} を使用します。`,
  );
  return { start: base.start, end: base.end };
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
    workingHours: resolveWorkingHours(db, base.workingHours),
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
