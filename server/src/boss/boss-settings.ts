import type { Db } from "../db/db-port.js";
import { readSettingsSnapshot, type SettingsSnapshot } from "../settings/settings-repository.js";
import { DEFAULT_MODEL } from "../llm/claude-client.js";
import {
  DEFAULT_PERSONA_SETTINGS,
  MAX_STRICTNESS,
  MIN_STRICTNESS,
  TONE_PRESETS,
  type PersonaSettings,
  type TonePreset,
} from "./persona-prompt.js";

export interface BossSettings {
  model: string;
  persona: PersonaSettings;
}

function isTonePreset(value: string): value is TonePreset {
  return (TONE_PRESETS as readonly string[]).includes(value);
}

function resolveTone(value: string | undefined): TonePreset {
  if (value !== undefined && isTonePreset(value)) {
    return value;
  }
  return DEFAULT_PERSONA_SETTINGS.tone;
}

function resolveStrictness(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PERSONA_SETTINGS.strictness;
  }

  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_STRICTNESS ||
    parsed > MAX_STRICTNESS
  ) {
    return DEFAULT_PERSONA_SETTINGS.strictness;
  }
  return parsed;
}

/**
 * Reads the model name and boss persona from the `settings` key-value table,
 * falling back to defaults (`DEFAULT_MODEL` / `DEFAULT_PERSONA_SETTINGS`)
 * for any key that is missing or holds an invalid value. Settings are
 * expected to be managed by the settings screen (Issue #8); this ticket
 * (#27) only needs to read them for chat.
 */
export function resolveBossSettingsFrom(settings: SettingsSnapshot): BossSettings {
  const model = settings.get("model") ?? DEFAULT_MODEL;

  const persona: PersonaSettings = {
    name: settings.get("boss_name") ?? DEFAULT_PERSONA_SETTINGS.name,
    tone: resolveTone(settings.get("boss_tone_preset")),
    strictness: resolveStrictness(settings.get("boss_strictness")),
    customInstructions:
      settings.get("boss_custom_instructions") ?? null,
  };

  return { model, persona };
}

/**
 * Reads the boss settings from one {@link SettingsSnapshot} (so the model and
 * the persona fields are never a mix of two concurrent saves — #603).
 */
export async function resolveBossSettings(db: Db): Promise<BossSettings> {
  return resolveBossSettingsFrom(await readSettingsSnapshot(db));
}
