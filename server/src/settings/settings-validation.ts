import { TONE_PRESETS, MIN_STRICTNESS, MAX_STRICTNESS } from "../boss/persona-prompt.js";
import { TIME_PATTERN } from "../detection/detection-types.js";

/**
 * The full set of keys the settings API (GET/PUT /api/settings) recognizes.
 * Deliberately kept in sync with the existing readers this ticket must not
 * diverge from: `boss/boss-settings.ts` (boss_*), `scheduler/detection-settings.ts`
 * (work_*, *_meeting_time, detection_*_fallback_minutes, escalation_*_minutes),
 * and `llm/claude-client.ts` (model). No new keys are invented here.
 */
export const SETTINGS_KEYS = [
  "boss_name",
  "boss_tone_preset",
  "boss_strictness",
  "boss_custom_instructions",
  "work_start",
  "work_end",
  "morning_meeting_time",
  "evening_meeting_time",
  "detection_unstarted_fallback_minutes",
  "detection_silence_fallback_minutes",
  "detection_break_fallback_minutes",
  "escalation_l2_after_minutes",
  "escalation_l3_after_minutes",
  "escalation_repeat_minutes",
  "model",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

/**
 * Normalized, storage-ready values for a `PUT /api/settings` request:
 * `string` for a value to upsert, `null` to reset the key back to "unset"
 * (see `settings/settings-repository.ts`'s `setSettingValue`).
 */
export type SettingsPatch = Partial<Record<SettingKey, string | null>>;

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

type FieldValidator = (
  value: unknown,
) => { valid: true; value: string | null } | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(value: string | null): { valid: true; value: string | null } {
  return { valid: true, value };
}

function err(error: string): { valid: false; error: string } {
  return { valid: false, error };
}

function validateNonEmptyString(key: SettingKey): FieldValidator {
  return (value) => {
    if (typeof value !== "string" || value.trim() === "") {
      return err(`${key} must be a non-empty string`);
    }
    return ok(value.trim());
  };
}

function validateTonePreset(value: unknown) {
  if (
    typeof value !== "string" ||
    !(TONE_PRESETS as readonly string[]).includes(value)
  ) {
    return err(
      `boss_tone_preset must be one of: ${TONE_PRESETS.join(", ")}`,
    );
  }
  return ok(value);
}

function validateStrictness(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_STRICTNESS ||
    value > MAX_STRICTNESS
  ) {
    return err(
      `boss_strictness must be an integer between ${MIN_STRICTNESS} and ${MAX_STRICTNESS}`,
    );
  }
  return ok(String(value));
}

// Empty string (or `null`, which is what GET returns when unset — accepted
// so a client can round-trip a GET response straight back into a PUT)
// means "reset to unset" (see settings-repository.ts's
// setSettingValue(db, key, null) semantics) so that resolveBossSettings
// falls back to DEFAULT_PERSONA_SETTINGS.customInstructions (null).
function validateCustomInstructions(value: unknown) {
  if (value === null) {
    return ok(null);
  }
  if (typeof value !== "string") {
    return err("boss_custom_instructions must be a string or null");
  }
  return ok(value === "" ? null : value);
}

function validateTime(key: SettingKey): FieldValidator {
  return (value) => {
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
      return err(`${key} must be in "HH:mm" format`);
    }
    return ok(value);
  };
}

function validatePositiveIntegerMinutes(key: SettingKey): FieldValidator {
  return (value) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return err(`${key} must be a positive integer`);
    }
    return ok(String(value));
  };
}

const VALIDATORS: Record<SettingKey, FieldValidator> = {
  boss_name: validateNonEmptyString("boss_name"),
  boss_tone_preset: validateTonePreset,
  boss_strictness: validateStrictness,
  boss_custom_instructions: validateCustomInstructions,
  work_start: validateTime("work_start"),
  work_end: validateTime("work_end"),
  morning_meeting_time: validateTime("morning_meeting_time"),
  evening_meeting_time: validateTime("evening_meeting_time"),
  detection_unstarted_fallback_minutes: validatePositiveIntegerMinutes(
    "detection_unstarted_fallback_minutes",
  ),
  detection_silence_fallback_minutes: validatePositiveIntegerMinutes(
    "detection_silence_fallback_minutes",
  ),
  detection_break_fallback_minutes: validatePositiveIntegerMinutes(
    "detection_break_fallback_minutes",
  ),
  escalation_l2_after_minutes: validatePositiveIntegerMinutes(
    "escalation_l2_after_minutes",
  ),
  escalation_l3_after_minutes: validatePositiveIntegerMinutes(
    "escalation_l3_after_minutes",
  ),
  escalation_repeat_minutes: validatePositiveIntegerMinutes(
    "escalation_repeat_minutes",
  ),
  model: validateNonEmptyString("model"),
};

function isSettingKey(key: string): key is SettingKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

/**
 * Validates and normalizes a `PUT /api/settings` request body into a
 * {@link SettingsPatch} ready for persistence. Returns a descriptive error
 * on the first invalid key encountered (short-circuits — it does not
 * collect every error in the body), so callers can implement
 * "all-or-nothing" writes: since nothing is written until validation
 * as a whole succeeds, a single invalid key means no key is saved.
 */
export function validatePutSettingsInput(
  body: unknown,
): ValidationResult<SettingsPatch> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  const data: SettingsPatch = {};

  for (const key of Object.keys(body)) {
    if (!isSettingKey(key)) {
      return { valid: false, error: `unrecognized setting key: ${key}` };
    }

    const result = VALIDATORS[key](body[key]);
    if (!result.valid) {
      return { valid: false, error: result.error };
    }

    data[key] = result.value;
  }

  return { valid: true, data };
}
