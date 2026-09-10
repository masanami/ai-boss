import { TONE_PRESETS, MIN_STRICTNESS, MAX_STRICTNESS } from "../boss/persona-prompt.js";
import { TIME_PATTERN } from "../detection/detection-types.js";
import { timeStringToMinutes } from "../detection/time-utils.js";

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
  "evidence_enforcement_enabled",
  "morning_mentoring_required",
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

// boolean 設定キー共通のバリデータ。JSON では boolean、保存は
// "true" / "false" の文字列
// （機能仕様 docs/features/completion-evidence-enforcement.md 決定 7・
// docs/features/work-approach-mentoring.md 判断 7）。
// 既定値の向き（未設定・不正値をオンに倒すかオフに倒すか）はキーごとに
// 異なり、ここではなく読み手側（evidence-settings.ts / mentoring-settings.ts）
// が持つ。バリデータは「JSON boolean 以外を拒否する」ことだけを担う。
// "1" / "0" は既存の数値設定と見た目が区別できなくなるため使わない。
// JSON の boolean のみを受け付け、"true" のような文字列や 1 / 0 の数値は
// 拒否する（呼び出し元が GET のレスポンスをそのまま PUT に送り返せるよう、
// 型を JSON boolean に固定する）。
function validateBoolean(key: SettingKey): FieldValidator {
  return (value) => {
    if (typeof value !== "boolean") {
      return err(`${key} must be a boolean`);
    }
    return ok(value ? "true" : "false");
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
  evidence_enforcement_enabled: validateBoolean("evidence_enforcement_enabled"),
  morning_mentoring_required: validateBoolean("morning_mentoring_required"),
};

function isSettingKey(key: string): key is SettingKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

/**
 * Shared `work_start` / `work_end` correlation predicate (親要件 #448 決定
 * 1・2）。`start` と `end` はいずれも "HH:mm" 形式（`TIME_PATTERN` 準拠）を
 * 前提とする — 書式検証はこの関数の責務ではなく、呼び出し側が別途
 * 行う（本ファイルでは `validateTime`）。`start >= end`（区間が空になる。
 * 日またぎの `22:00`-`02:00` も同時刻の `09:00`-`09:00` も含む）のときのみ
 * `false` を返す。
 *
 * この関数はこのチケット（#480: 全量更新の拒否）に閉じず、部分更新の
 * 相関チェック配線（#481）と読み出し側ガード（#482）からも再利用される
 * 共有ヘルパーとしてエクスポートする（DRY: 述語を複数箇所へ重複実装
 * しない）。
 *
 * **配置について**: 書き込み側バリデータであるこのファイルに置くのは、
 * #480（本チケット）の唯一の呼び出し元が `validatePutSettingsInput`
 * だからである（YAGNI: 呼び出し元が1つのうちに独立モジュールへの切り
 * 出しを先取りしない）。**中立な置き場（例: `detection/time-utils.ts`）
 * へ最初から置く選択肢が閉じているわけではない** — 本ファイルは既に
 * `detection/time-utils.ts` を import しており（`timeStringToMinutes`）、
 * `detection/` 側から `settings/` への import は無いため、そちらへ
 * 置いても新たなパッケージ間の辺は増えない。むしろ現状のまま将来
 * #482（`scheduler/detection-settings.ts`）がこの関数を import すると、
 * 既存の `settings-routes.ts` → `scheduler/detection-settings.ts` の
 * 辺と合わせて settings↔scheduler の結合が深まる。#481/#482 で呼び出し元
 * が増えた時点で、中立モジュールへの切り出しを改めて検討すること。
 *
 * **形式が不正な入力への挙動（fail-open）**: `timeStringToMinutes` が
 * `null` を返す場合（形式不正）、この関数は `true`（相関エラーなし）を
 * 返す — 形式検証は呼び出し側の責務であり、ここで二重にガードしない
 * ための意図的な設計判断である。**呼び出し元への注意**: `timeStringToMinutes`
 * は不正な入力に対して `console.warn` を出す副作用を持つ
 * （`detection/time-utils.ts`）。#482 のように DB の生値（書式検証を経て
 * いない可能性がある値）をこの関数へ渡す呼び出し元は、この警告ログが
 * 発生しうることを踏まえて設計すること。
 */
export function isValidWorkingHoursRange(start: string, end: string): boolean {
  const startMinutes = timeStringToMinutes(start);
  const endMinutes = timeStringToMinutes(end);
  if (startMinutes === null || endMinutes === null) {
    return true;
  }
  return startMinutes < endMinutes;
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

  // work_start / work_end 相関チェック（#480: 全量更新の拒否まで。
  // 部分更新——送られなかった側の現在の保存値・既定値との突き合わせ——
  // の配線は #481 の範囲なので、ここでは両方が同時に送られた場合にのみ
  // 検査する（片方だけの更新は関知しない）。
  if (
    typeof data.work_start === "string" &&
    typeof data.work_end === "string" &&
    !isValidWorkingHoursRange(data.work_start, data.work_end)
  ) {
    return err("work_start must be earlier than work_end");
  }

  return { valid: true, data };
}
