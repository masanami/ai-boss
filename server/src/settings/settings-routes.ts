import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readJsonBody } from "../lib/read-json-body.js";
import { getSettingValue, setSettingValue } from "./settings-repository.js";
import {
  isValidWorkingHoursRange,
  validatePutSettingsInput,
  type SettingsPatch,
} from "./settings-validation.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { loadDetectionSettings } from "../scheduler/detection-settings.js";
import { resolveEvidenceSettings } from "./evidence-settings.js";
import { resolveMorningMentoringRequired } from "./mentoring-settings.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  TIME_PATTERN,
} from "../detection/detection-types.js";

/**
 * Flat, key-named view of the effective settings, as returned by
 * `GET /api/settings`. Built from the same readers the rest of the app
 * uses (`resolveBossSettings` / `loadDetectionSettings`) so the API can
 * never drift from what those readers actually see.
 */
function readEffectiveSettings(db: Database.Database) {
  const { model, persona } = resolveBossSettings(db);
  const detection = loadDetectionSettings(db);
  const evidence = resolveEvidenceSettings(db);
  const morningMentoringRequired = resolveMorningMentoringRequired(db);

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
    evidence_enforcement_enabled: evidence.enforcementEnabled,
    morning_mentoring_required: morningMentoringRequired,
  };
}

/**
 * Resolves the "HH:mm" work_start/work_end pair that will actually be
 * persisted once `patch` is applied — the basis for the partial-update
 * correlation check below (#481, 親要件 #448 決定1・6).
 *
 * For a key present in `patch`, that incoming value is what will be
 * written, so it wins. For a key *not* present in `patch`, this reads the
 * **raw** stored value via `getSettingValue` — not a fallback-applying
 * reader such as `loadDetectionSettings` — so an already-invalid stored
 * value isn't masked by its would-be-effective fallback (決定 1). A
 * genuinely unset key (`getSettingValue` returns `undefined`) falls back
 * to the default, which is the value that *would* actually take effect for
 * an unset key (決定 6) — matching `DEFAULT_DETECTION_SETTINGS.workingHours`,
 * the same defaults `loadDetectionSettings` resolves an unset key to.
 *
 * A stored raw value that fails `TIME_PATTERN` (format-invalid — only
 * reachable by writing to the `settings` table directly, since
 * `validatePutSettingsInput` never lets this route persist one) is treated
 * the same as unset (falls back to the default) rather than passed through
 * as-is. `isValidWorkingHoursRange` itself fails open (returns `true`) for
 * a format-invalid input — that is the right contract for *that* shared
 * predicate (format validation is each caller's job), but if this resolver
 * forwarded a format-invalid raw value unchanged, the fail-open would
 * silently skip the correlation check this route exists to run. Falling
 * back to the default here keeps the check meaningful without duplicating
 * `TIME_PATTERN` validation into the predicate itself.
 */
function resolveStoredOrDefaultTime(
  db: Database.Database,
  key: "work_start" | "work_end",
  fallback: string,
): string {
  const raw = getSettingValue(db, key);
  if (raw !== undefined && TIME_PATTERN.test(raw)) {
    return raw;
  }
  return fallback;
}

function resolveEffectiveWorkingHours(
  db: Database.Database,
  patch: SettingsPatch,
): { start: string; end: string } {
  const start =
    patch.work_start ??
    resolveStoredOrDefaultTime(
      db,
      "work_start",
      DEFAULT_DETECTION_SETTINGS.workingHours.start,
    );
  const end =
    patch.work_end ??
    resolveStoredOrDefaultTime(
      db,
      "work_end",
      DEFAULT_DETECTION_SETTINGS.workingHours.end,
    );
  return { start, end };
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

    // Partial-update correlation check (#481, 親要件 #448 決定1・6):
    // `validatePutSettingsInput` only checks work_start/work_end against
    // each other when *both* are sent in the same request (see its own
    // comment) — it has no DB access, so it cannot know the other side's
    // current value for a partial update. Only run this when the patch
    // actually touches one of the two keys, so patches that leave working
    // hours untouched are never blocked by a pre-existing invalid pair
    // (that pair is the read-side guard's job, #482 — not this route's).
    if (result.data.work_start !== undefined || result.data.work_end !== undefined) {
      const { start, end } = resolveEffectiveWorkingHours(db, result.data);
      if (!isValidWorkingHoursRange(start, end)) {
        return c.json({ error: "work_start must be earlier than work_end" }, 400);
      }
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
