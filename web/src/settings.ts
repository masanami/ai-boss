/**
 * Tone presets and their storage values must stay in lockstep with the
 * server (`server/src/boss/persona-prompt.ts`'s `TONE_PRESETS`). Duplicated
 * here rather than imported since `web/` and `server/` are separate npm
 * workspaces with no shared package.
 */
export const TONE_PRESETS = [
  "reliable",
  "strict",
  "logical",
  "passionate",
] as const;
export type TonePreset = (typeof TONE_PRESETS)[number];

export const TONE_PRESET_LABELS: Record<TonePreset, string> = {
  reliable: "信頼できる上司（既定）",
  strict: "厳格",
  logical: "ロジカル",
  passionate: "熱血",
};

export const MIN_STRICTNESS = 1;
export const MAX_STRICTNESS = 5;

/**
 * Labels for the 1..5 strictness scale. Only the two endpoints are
 * specified by the ticket ("1 とても緩やか〜5 非常に厳しい"); the
 * intermediate labels (2〜4) are an explicit assumption made to fill out a
 * usable select control.
 */
export const STRICTNESS_LABELS: Record<number, string> = {
  1: "とても緩やか",
  2: "緩やか",
  3: "標準",
  4: "厳しい",
  5: "非常に厳しい",
};

/**
 * The full effective settings shape returned by `GET /api/settings` and
 * accepted (as a partial) by `PUT /api/settings`. Keys and value types
 * (number vs. string) must match `server/src/settings/settings-validation.ts`
 * exactly — no new keys are invented here.
 */
export interface Settings {
  boss_name: string;
  boss_tone_preset: TonePreset;
  boss_strictness: number;
  boss_custom_instructions: string | null;
  work_start: string;
  work_end: string;
  morning_meeting_time: string;
  evening_meeting_time: string;
  detection_unstarted_fallback_minutes: number;
  detection_silence_fallback_minutes: number;
  detection_break_fallback_minutes: number;
  escalation_l2_after_minutes: number;
  escalation_l3_after_minutes: number;
  escalation_repeat_minutes: number;
  model: string;
}

/** `PUT /api/settings` accepts a partial update; this app always sends the full form. */
export type SettingsPatch = Partial<Settings>;
