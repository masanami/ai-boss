import { describe, expect, it } from "vitest";
import {
  isValidWorkingHoursRange,
  validatePutSettingsInput,
} from "./settings-validation.js";

const TIME_KEYS = [
  "work_start",
  "work_end",
  "morning_meeting_time",
  "evening_meeting_time",
] as const;

// #517: 決定 3 の日本語 error 文言（画面・API設計の表そのもの）。実装の
// SETTING_LABELS からは独立に、仕様の表を直接転記する（実装を参照すると
// 恒真になり、文言が崩れたことを検出できなくなるため）。
const TIME_KEY_ERRORS: Record<(typeof TIME_KEYS)[number], string> = {
  work_start: "勤務開始の時刻を 09:00 の形式で入力してください",
  work_end: "勤務終了の時刻を 09:00 の形式で入力してください",
  morning_meeting_time: "朝会の時刻を 09:00 の形式で入力してください",
  evening_meeting_time: "夕会の時刻を 09:00 の形式で入力してください",
};

const MINUTE_KEYS = [
  "detection_unstarted_fallback_minutes",
  "detection_silence_fallback_minutes",
  "detection_break_fallback_minutes",
  "escalation_l2_after_minutes",
  "escalation_l3_after_minutes",
  "escalation_repeat_minutes",
] as const;

const MINUTE_KEY_ERRORS: Record<(typeof MINUTE_KEYS)[number], string> = {
  detection_unstarted_fallback_minutes:
    "未着手のフォールバック（分）には 1 以上の整数を入力してください",
  detection_silence_fallback_minutes:
    "無音のフォールバック（分）には 1 以上の整数を入力してください",
  detection_break_fallback_minutes:
    "休憩のフォールバック（分）には 1 以上の整数を入力してください",
  escalation_l2_after_minutes:
    "エスカレーション: レベル2まで（分）には 1 以上の整数を入力してください",
  escalation_l3_after_minutes:
    "エスカレーション: レベル3まで（分）には 1 以上の整数を入力してください",
  escalation_repeat_minutes:
    "エスカレーション: 再通知間隔（分）には 1 以上の整数を入力してください",
};

describe("validatePutSettingsInput", () => {
  it("rejects a non-object body (array)", () => {
    const result = validatePutSettingsInput([]);
    expect(result.valid).toBe(false);
  });

  it("rejects a non-object body (null)", () => {
    const result = validatePutSettingsInput(null);
    expect(result.valid).toBe(false);
  });

  it("rejects a non-object body (string)", () => {
    const result = validatePutSettingsInput("not an object");
    expect(result.valid).toBe(false);
  });

  it("accepts an empty object (no-op update)", () => {
    const result = validatePutSettingsInput({});
    expect(result).toEqual({ valid: true, data: {} });
  });

  it("rejects an unrecognized key", () => {
    const result = validatePutSettingsInput({ not_a_real_key: "x" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("not_a_real_key");
    }
  });

  describe("boss_name", () => {
    it("accepts a non-empty string", () => {
      const result = validatePutSettingsInput({ boss_name: "鬼上司" });
      expect(result).toEqual({ valid: true, data: { boss_name: "鬼上司" } });
    });

    it.each(["", "   "])(
      "rejects %j with the Japanese error and code (setting_required) (#517)",
      (value) => {
        const result = validatePutSettingsInput({ boss_name: value });
        expect(result).toEqual({
          valid: false,
          error: "ボスの名前を入力してください",
          code: "setting_required",
        });
      },
    );

    it("rejects a non-string value", () => {
      const result = validatePutSettingsInput({ boss_name: 123 });
      expect(result.valid).toBe(false);
    });
  });

  describe("boss_tone_preset", () => {
    for (const tone of ["reliable", "strict", "logical", "passionate"]) {
      it(`accepts "${tone}"`, () => {
        const result = validatePutSettingsInput({ boss_tone_preset: tone });
        expect(result).toEqual({
          valid: true,
          data: { boss_tone_preset: tone },
        });
      });
    }

    it("rejects a value outside the tone presets", () => {
      const result = validatePutSettingsInput({ boss_tone_preset: "gentle" });
      expect(result.valid).toBe(false);
    });
  });

  describe("boss_strictness", () => {
    for (const strictness of [1, 2, 3, 4, 5]) {
      it(`accepts ${strictness}`, () => {
        const result = validatePutSettingsInput({
          boss_strictness: strictness,
        });
        expect(result).toEqual({
          valid: true,
          data: { boss_strictness: String(strictness) },
        });
      });
    }

    it("rejects 0 (below range)", () => {
      const result = validatePutSettingsInput({ boss_strictness: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects 6 (above range)", () => {
      const result = validatePutSettingsInput({ boss_strictness: 6 });
      expect(result.valid).toBe(false);
    });

    it("rejects a non-integer number", () => {
      const result = validatePutSettingsInput({ boss_strictness: 2.5 });
      expect(result.valid).toBe(false);
    });

    it("rejects a numeric string (must be a JSON number)", () => {
      const result = validatePutSettingsInput({ boss_strictness: "3" });
      expect(result.valid).toBe(false);
    });
  });

  describe("boss_custom_instructions", () => {
    it("accepts a non-empty string as-is", () => {
      const result = validatePutSettingsInput({
        boss_custom_instructions: "丁寧に接すること",
      });
      expect(result).toEqual({
        valid: true,
        data: { boss_custom_instructions: "丁寧に接すること" },
      });
    });

    it("normalizes an empty string to null (reset to unset)", () => {
      const result = validatePutSettingsInput({
        boss_custom_instructions: "",
      });
      expect(result).toEqual({
        valid: true,
        data: { boss_custom_instructions: null },
      });
    });

    it("accepts null directly as reset to unset (round-trips GET's null response)", () => {
      const result = validatePutSettingsInput({
        boss_custom_instructions: null,
      });
      expect(result).toEqual({
        valid: true,
        data: { boss_custom_instructions: null },
      });
    });

    it("rejects a non-string, non-null value", () => {
      const result = validatePutSettingsInput({
        boss_custom_instructions: 123,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe.each(TIME_KEYS)("%s", (key) => {
    it("accepts a valid HH:mm value", () => {
      const result = validatePutSettingsInput({ [key]: "09:30" });
      expect(result).toEqual({ valid: true, data: { [key]: "09:30" } });
    });

    it.each(["", "9:00"])(
      "rejects %j with the Japanese error and code (invalid_time) (#517)",
      (value) => {
        const result = validatePutSettingsInput({ [key]: value });
        expect(result).toEqual({
          valid: false,
          error: TIME_KEY_ERRORS[key],
          code: "invalid_time",
        });
      },
    );

    it("rejects a value missing zero-padding", () => {
      const result = validatePutSettingsInput({ [key]: "9:30" });
      expect(result.valid).toBe(false);
    });

    it("rejects an out-of-range hour", () => {
      const result = validatePutSettingsInput({ [key]: "24:00" });
      expect(result.valid).toBe(false);
    });

    it("rejects a non-string value", () => {
      const result = validatePutSettingsInput({ [key]: 900 });
      expect(result.valid).toBe(false);
    });
  });

  describe.each(MINUTE_KEYS)("%s", (key) => {
    it("accepts a positive integer", () => {
      const result = validatePutSettingsInput({ [key]: 30 });
      expect(result).toEqual({ valid: true, data: { [key]: "30" } });
    });

    it.each([0, -5, 1.5])(
      "rejects %s with the Japanese error and code (invalid_positive_integer) (#517)",
      (value) => {
        const result = validatePutSettingsInput({ [key]: value });
        expect(result).toEqual({
          valid: false,
          error: MINUTE_KEY_ERRORS[key],
          code: "invalid_positive_integer",
        });
      },
    );

    it("rejects a numeric string", () => {
      const result = validatePutSettingsInput({ [key]: "30" });
      expect(result.valid).toBe(false);
    });
  });

  describe("model", () => {
    it("accepts a non-empty string", () => {
      const result = validatePutSettingsInput({ model: "claude-opus-4-8" });
      expect(result).toEqual({
        valid: true,
        data: { model: "claude-opus-4-8" },
      });
    });

    it.each(["", "   "])(
      "rejects %j with the Japanese error and code (setting_required) (#517)",
      (value) => {
        const result = validatePutSettingsInput({ model: value });
        expect(result).toEqual({
          valid: false,
          error: "モデルを入力してください",
          code: "setting_required",
        });
      },
    );

    it("rejects a non-string value", () => {
      const result = validatePutSettingsInput({ model: 42 });
      expect(result.valid).toBe(false);
    });
  });

  // エビデンス強制設定（#386）。決定 7: JSON は boolean、保存は "true" /
  // "false" の文字列（"1" / "0" は使わない）。
  describe("evidence_enforcement_enabled", () => {
    it("accepts true and normalizes it to the string \"true\"", () => {
      const result = validatePutSettingsInput({
        evidence_enforcement_enabled: true,
      });
      expect(result).toEqual({
        valid: true,
        data: { evidence_enforcement_enabled: "true" },
      });
    });

    it("accepts false and normalizes it to the string \"false\"", () => {
      const result = validatePutSettingsInput({
        evidence_enforcement_enabled: false,
      });
      expect(result).toEqual({
        valid: true,
        data: { evidence_enforcement_enabled: "false" },
      });
    });

    it('rejects the string "true" (must be a JSON boolean, not a string)', () => {
      const result = validatePutSettingsInput({
        evidence_enforcement_enabled: "true",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects the number 1", () => {
      const result = validatePutSettingsInput({
        evidence_enforcement_enabled: 1,
      });
      expect(result.valid).toBe(false);
    });

    it("rejects null", () => {
      const result = validatePutSettingsInput({
        evidence_enforcement_enabled: null,
      });
      expect(result.valid).toBe(false);
    });
  });

  // 朝会メンタリング必須設定（#406）。判断7: settings KV における boolean
  // キーの第1号。evidence_enforcement_enabled と同じ validateBoolean を
  // 再利用する（既定値の向きが異なるのは読み手側 resolveMorningMentoringRequired
  // の責務であり、ここでの受理・拒否の形は同一）。
  describe("morning_mentoring_required", () => {
    it('accepts true and normalizes it to the string "true"', () => {
      const result = validatePutSettingsInput({
        morning_mentoring_required: true,
      });
      expect(result).toEqual({
        valid: true,
        data: { morning_mentoring_required: "true" },
      });
    });

    it('accepts false and normalizes it to the string "false"', () => {
      const result = validatePutSettingsInput({
        morning_mentoring_required: false,
      });
      expect(result).toEqual({
        valid: true,
        data: { morning_mentoring_required: "false" },
      });
    });

    it('rejects the string "true" (must be a JSON boolean, not a string) (AC-34)', () => {
      const result = validatePutSettingsInput({
        morning_mentoring_required: "true",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects null (AC-35)", () => {
      const result = validatePutSettingsInput({
        morning_mentoring_required: null,
      });
      expect(result.valid).toBe(false);
    });

    it("rejects the number 1", () => {
      const result = validatePutSettingsInput({
        morning_mentoring_required: 1,
      });
      expect(result.valid).toBe(false);
    });
  });

  it("accepts multiple valid keys together", () => {
    const result = validatePutSettingsInput({
      boss_name: "鬼上司",
      boss_strictness: 5,
      work_start: "08:00",
    });
    expect(result).toEqual({
      valid: true,
      data: {
        boss_name: "鬼上司",
        boss_strictness: "5",
        work_start: "08:00",
      },
    });
  });

  it("rejects the whole patch when any single key is invalid (all-or-nothing)", () => {
    const result = validatePutSettingsInput({
      boss_name: "鬼上司",
      boss_strictness: 99,
    });
    expect(result.valid).toBe(false);
  });

  // work_start / work_end 相関チェック（#480, 親要件 #448 決定1・2）。
  // 本チケットが担うのは「全量更新（両キーが同時に送られる更新）」の拒否
  // まで。部分更新（片方だけ送る更新）の相関チェックは、この純粋関数
  // （DB アクセスを持たない）ではなく #481 が `settings-routes.ts`
  // （DB から現在の保存値を読める層）に配線する設計であり、この関数は
  // 片方だけ送られたときは意図的に関知しない。#481 実装後もこの関数
  // レベルの契約は変わらないため、ここでは「片方だけ送られたときは拒否
  // しない」ことも合わせて確認し、越権していないことを担保する
  // （HTTP レベルの部分更新拒否の担保は `settings-routes.test.ts` 側）。
  describe("work_start / work_end correlation (AC-1, AC-2, AC-5, AC-6)", () => {
    it("accepts a valid range (work_start=09:00, work_end=18:00) (AC-5)", () => {
      const result = validatePutSettingsInput({
        work_start: "09:00",
        work_end: "18:00",
      });
      expect(result).toEqual({
        valid: true,
        data: { work_start: "09:00", work_end: "18:00" },
      });
    });

    it.each([
      ["22:00", "02:00"],
      ["09:00", "09:00"],
    ])(
      "rejects an invalid range (work_start=%s, work_end=%s) with the Japanese error and code (invalid_working_hours) when both are sent (AC-1, AC-2, decision 2: >=) (#517)",
      (start, end) => {
        const result = validatePutSettingsInput({
          work_start: start,
          work_end: end,
        });
        expect(result).toEqual({
          valid: false,
          error: "勤務開始は勤務終了より前の時刻にしてください",
          code: "invalid_working_hours",
        });
      },
    );

    it("does not reject when only work_start is sent (partial-update correlation is wired in settings-routes.ts by #481, not here)", () => {
      const result = validatePutSettingsInput({ work_start: "23:00" });
      expect(result).toEqual({
        valid: true,
        data: { work_start: "23:00" },
      });
    });

    it("does not reject when only work_end is sent (partial-update correlation is wired in settings-routes.ts by #481, not here)", () => {
      const result = validatePutSettingsInput({ work_end: "01:00" });
      expect(result).toEqual({
        valid: true,
        data: { work_end: "01:00" },
      });
    });

    it("rejects the whole patch when the working-hours correlation is invalid, even alongside other valid keys (all-or-nothing)", () => {
      const result = validatePutSettingsInput({
        boss_name: "鬼上司",
        work_start: "22:00",
        work_end: "02:00",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("isValidWorkingHoursRange (shared helper for #481/#482)", () => {
    it("returns true for a normal daytime range", () => {
      expect(isValidWorkingHoursRange("09:00", "18:00")).toBe(true);
    });

    it("returns true for a range one minute wide", () => {
      expect(isValidWorkingHoursRange("17:59", "18:00")).toBe(true);
    });

    it("returns false for an overnight range (start > end)", () => {
      expect(isValidWorkingHoursRange("22:00", "02:00")).toBe(false);
    });

    it("returns false for an equal start/end (decision 2: >=, not >)", () => {
      expect(isValidWorkingHoursRange("09:00", "09:00")).toBe(false);
    });
  });
});
