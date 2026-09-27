import { Hono } from "hono";
import type { Db } from "../db/db-port.js";
import { readJsonBody } from "../lib/read-json-body.js";
import {
  readSettingsSnapshot,
  setSettingValue,
  type SettingsSnapshot,
} from "./settings-repository.js";
import {
  isValidWorkingHoursRange,
  validatePutSettingsInput,
  WORKING_HOURS_ERROR,
  WORKING_HOURS_CODE,
  type SettingsPatch,
} from "./settings-validation.js";
import { resolveBossSettingsFrom } from "../boss/boss-settings.js";
import { resolveDetectionSettings } from "../scheduler/detection-settings.js";
import { resolveEvidenceSettingsFrom } from "./evidence-settings.js";
import { resolveMorningMentoringRequiredFrom } from "./mentoring-settings.js";
import {
  DEFAULT_DETECTION_SETTINGS,
  TIME_PATTERN,
} from "../detection/detection-types.js";

/**
 * Flat, key-named view of the effective settings, as returned by
 * `GET /api/settings`. Built from the same readers the rest of the app
 * uses (`resolveBossSettings` / `loadDetectionSettings`) so the API can
 * never drift from what those readers actually see.
 *
 * Every key is read from one {@link SettingsSnapshot} (#603・Issue #597 の
 * コメント P2): reading each reader's keys with separate awaits would let a
 * concurrent `PUT /api/settings` commit land in between and return a mix of
 * old and new values that never existed together in the DB.
 */
async function readEffectiveSettings(db: Db) {
  const stored = await readSettingsSnapshot(db);
  const { model, persona } = resolveBossSettingsFrom(stored);
  const detection = resolveDetectionSettings(stored);
  const evidence = resolveEvidenceSettingsFrom(stored);
  const morningMentoringRequired = resolveMorningMentoringRequiredFrom(stored);

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
    detection_daily_notification_cap: detection.dailyNotificationCap,
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
 * **raw** stored value from the snapshot — not a fallback-applying
 * reader such as `loadDetectionSettings` — so an already-invalid stored
 * value isn't masked by its would-be-effective fallback (決定 1). A
 * genuinely unset key (absent from the snapshot) falls back
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
  stored: SettingsSnapshot,
  key: "work_start" | "work_end",
  fallback: string,
): string {
  const raw = stored.get(key);
  if (raw !== undefined && TIME_PATTERN.test(raw)) {
    return raw;
  }
  return fallback;
}

function resolveEffectiveWorkingHours(
  stored: SettingsSnapshot,
  patch: SettingsPatch,
): { start: string; end: string } {
  const start =
    patch.work_start ??
    resolveStoredOrDefaultTime(
      stored,
      "work_start",
      DEFAULT_DETECTION_SETTINGS.workingHours.start,
    );
  const end =
    patch.work_end ??
    resolveStoredOrDefaultTime(
      stored,
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
export function createSettingsRouter(db: Db): Hono {
  const settings = new Hono();

  settings.get("/", async (c) => {
    return c.json(await readEffectiveSettings(db));
  });

  settings.put("/", async (c) => {
    const body = await readJsonBody(c);

    const result = validatePutSettingsInput(body);
    if (!result.valid) {
      // #517 決定1・決定2: validatePutSettingsInput が code を付けて返した
      // 5箇所だけ {error, code} にする。それ以外（対象外の400）は code を
      // 付けず従来どおり {error} のみを返す。
      return c.json(
        result.code === undefined
          ? { error: result.error }
          : { error: result.error, code: result.code },
        400,
      );
    }

    // Partial-update correlation check (#481, 親要件 #448 決定1・6):
    // `validatePutSettingsInput` only checks work_start/work_end against
    // each other when *both* are sent in the same request (see its own
    // comment) — it has no DB access, so it cannot know the other side's
    // current value for a partial update. Only run this when the patch
    // actually touches one of the two keys, so patches that leave working
    // hours untouched are never blocked by a pre-existing invalid pair
    // (that pair is the read-side guard's job, #482 — not this route's).
    //
    // T1（#603・機能仕様 docs/features/async-db-layer.md 決定 2）: the stored
    // counterpart is read *inside* the same transaction that writes the patch.
    // Reading it before the transaction would let a concurrent `work_start`-
    // only and `work_end`-only request each validate against the other's
    // stale value and both commit, persisting a start-not-before-end pair
    // (AC-17). The transaction also keeps "invalid input saves nothing" true
    // as "any failure saves nothing" (AC-5).
    const touchesWorkingHours =
      result.data.work_start !== undefined || result.data.work_end !== undefined;
    const patch: Record<string, string | null> = result.data;
    const saved = await db.transaction(async (tx) => {
      if (touchesWorkingHours) {
        const { start, end } = resolveEffectiveWorkingHours(
          await readSettingsSnapshot(tx),
          result.data,
        );
        if (!isValidWorkingHoursRange(start, end)) {
          return false;
        }
      }
      for (const [key, value] of Object.entries(patch)) {
        await setSettingValue(tx, key, value);
      }
      return true;
    });

    if (!saved) {
      // #517 決定5: :272（settings-validation.ts）とは独立にオブジェクトを
      // 組む（定数は共有するが組み立て文は共有しない。片方だけを崩す変異で
      // 片方のテストだけが落ちることを担保するため）。
      return c.json(
        { error: WORKING_HOURS_ERROR, code: WORKING_HOURS_CODE },
        400,
      );
    }

    return c.json(await readEffectiveSettings(db));
  });

  return settings;
}
