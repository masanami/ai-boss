import { describe, expect, it } from "vitest";
import {
  parseEveningSummaryToolInput,
  SUBMIT_EVENING_SUMMARY_TOOL,
} from "./evening-summary-tool.js";

describe("SUBMIT_EVENING_SUMMARY_TOOL", () => {
  it("requires report_summary / boss_comment / carry_over", () => {
    expect(SUBMIT_EVENING_SUMMARY_TOOL.input_schema.required).toEqual([
      "report_summary",
      "boss_comment",
      "carry_over",
    ]);
  });
});

describe("parseEveningSummaryToolInput", () => {
  it("returns valid data with camelCase fields when all 3 values are non-empty strings", () => {
    const result = parseEveningSummaryToolInput({
      report_summary: "タスクAを完了した",
      boss_comment: "よくやった",
      carry_over: "タスクBを明日に持ち越す",
    });

    expect(result).toEqual({
      valid: true,
      data: {
        reportSummary: "タスクAを完了した",
        bossComment: "よくやった",
        carryOver: "タスクBを明日に持ち越す",
      },
    });
  });

  it("accepts carry_over: 'なし' as a valid non-empty value (no-carry-over case)", () => {
    const result = parseEveningSummaryToolInput({
      report_summary: "タスクAを完了した",
      boss_comment: "よくやった",
      carry_over: "なし",
    });

    expect(result.valid).toBe(true);
  });

  it("rejects a non-object input", () => {
    expect(parseEveningSummaryToolInput("not-an-object")).toEqual({
      valid: false,
      error: expect.any(String),
    });
    expect(parseEveningSummaryToolInput(null)).toEqual({
      valid: false,
      error: expect.any(String),
    });
  });

  it.each(["report_summary", "boss_comment", "carry_over"])(
    "rejects when %s is missing",
    (field) => {
      const input: Record<string, string> = {
        report_summary: "要点",
        boss_comment: "講評",
        carry_over: "なし",
      };
      delete input[field];

      const result = parseEveningSummaryToolInput(input);

      expect(result.valid).toBe(false);
    },
  );

  it.each(["report_summary", "boss_comment", "carry_over"])(
    "rejects when %s is an empty string",
    (field) => {
      const input = {
        report_summary: "要点",
        boss_comment: "講評",
        carry_over: "なし",
        [field]: "",
      };

      const result = parseEveningSummaryToolInput(input);

      expect(result.valid).toBe(false);
    },
  );

  it.each(["report_summary", "boss_comment", "carry_over"])(
    "rejects when %s is whitespace only",
    (field) => {
      const input = {
        report_summary: "要点",
        boss_comment: "講評",
        carry_over: "なし",
        [field]: "   ",
      };

      const result = parseEveningSummaryToolInput(input);

      expect(result.valid).toBe(false);
    },
  );

  it.each(["report_summary", "boss_comment", "carry_over"])(
    "rejects when %s is not a string",
    (field) => {
      const input: Record<string, unknown> = {
        report_summary: "要点",
        boss_comment: "講評",
        carry_over: "なし",
        [field]: 123,
      };

      const result = parseEveningSummaryToolInput(input);

      expect(result.valid).toBe(false);
    },
  );
});
