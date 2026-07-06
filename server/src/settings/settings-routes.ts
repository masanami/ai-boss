import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { setSettingValue } from "./settings-repository.js";
import { validatePutSettingsInput } from "./settings-validation.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { loadDetectionSettings } from "../scheduler/detection-settings.js";

/**
 * Flat, key-named view of the effective settings, as returned by
 * `GET /api/settings`. Built from the same readers the rest of the app
 * uses (`resolveBossSettings` / `loadDetectionSettings`) so the API can
 * never drift from what those readers actually see.
 */
function readEffectiveSettings(db: Database.Database) {
  const { model, persona } = resolveBossSettings(db);
  const detection = loadDetectionSettings(db);

  return {
    boss_name: persona.name,
    boss_tone_preset: persona.tone,
    boss_strictness: persona.strictness,
    boss_custom_instructions: persona.customInstructions,
    work_start: detection.workingHours.start,
    work_end: detection.workingHours.end,
    morning_meeting_time: detection.morningMeetingTime,
    evening_meeting_time: detection.eveningMeetingTime,
    detection_unstarted_fallback_minutes: detection.unstarted.fallback,
    detection_silence_fallback_minutes: detection.silence.fallback,
    detection_break_fallback_minutes: detection.breakFallbackMinutes,
    escalation_l2_after_minutes: detection.escalation.level1ToLevel2Minutes,
    escalation_l3_after_minutes: detection.escalation.level2ToLevel3Minutes,
    escalation_repeat_minutes: detection.escalation.level3RepeatMinutes,
    model,
  };
}

/**
 * Creates the settings sub-router, mounted under `/api/settings` by the
 * caller. `PUT` validates every provided key before writing any of them
 * (all-or-nothing, see `settings-validation.ts`), then re-reads the
 * effective settings so the response always reflects what was actually
 * persisted.
 */
export function createSettingsRouter(db: Database.Database): Hono {
  const settings = new Hono();

  settings.get("/", (c) => {
    return c.json(readEffectiveSettings(db));
  });

  settings.put("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validatePutSettingsInput(body);
    if (!result.valid) {
      return c.json({ error: result.error }, 400);
    }

    // All keys are already validated above, so this write is the only
    // place a partial failure could occur (e.g. an unexpected DB error).
    // Wrapping it in a transaction keeps "invalid input saves nothing"
    // true as "any failure saves nothing" too.
    const applyPatch = db.transaction(
      (patch: Record<string, string | null>) => {
        for (const [key, value] of Object.entries(patch)) {
          setSettingValue(db, key, value);
        }
      },
    );
    applyPatch(result.data);

    return c.json(readEffectiveSettings(db));
  });

  return settings;
}
