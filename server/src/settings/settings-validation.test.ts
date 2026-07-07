import { describe, expect, it } from "vitest";
import { validatePutSettingsInput } from "./settings-validation.js";

const TIME_KEYS = [
  "work_start",
  "work_end",
  "morning_meeting_time",
  "evening_meeting_time",
] as const;

const MINUTE_KEYS = [
  "detection_unstarted_fallback_minutes",
  "detection_silence_fallback_minutes",
  "detection_break_fallback_minutes",
  "escalation_l2_after_minutes",
  "escalation_l3_after_minutes",
  "escalation_repeat_minutes",
] as const;

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

    it("rejects an empty string", () => {
      const result = validatePutSettingsInput({ boss_name: "" });
      expect(result.valid).toBe(false);
    });

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

    it("rejects 0", () => {
      const result = validatePutSettingsInput({ [key]: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects a negative number", () => {
      const result = validatePutSettingsInput({ [key]: -5 });
      expect(result.valid).toBe(false);
    });

    it("rejects a non-integer number", () => {
      const result = validatePutSettingsInput({ [key]: 1.5 });
      expect(result.valid).toBe(false);
    });

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

    it("rejects an empty string", () => {
      const result = validatePutSettingsInput({ model: "" });
      expect(result.valid).toBe(false);
    });

    it("rejects a non-string value", () => {
      const result = validatePutSettingsInput({ model: 42 });
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
});
