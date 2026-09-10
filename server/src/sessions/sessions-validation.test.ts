import { describe, expect, it } from "vitest";
import {
  validateChatMessageInput,
  validateCreateSessionInput,
} from "./sessions-validation.js";

describe("validateCreateSessionInput", () => {
  it.each(["morning", "evening", "adhoc"] as const)(
    "accepts a valid type: %s",
    (type) => {
      const result = validateCreateSessionInput({ type });

      expect(result).toEqual({ valid: true, data: { type } });
    },
  );

  it("rejects a body that is not a JSON object", () => {
    const result = validateCreateSessionInput("not an object");

    expect(result.valid).toBe(false);
  });

  it("rejects a missing type", () => {
    const result = validateCreateSessionInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("type");
    }
  });

  it("rejects an invalid type", () => {
    const result = validateCreateSessionInput({ type: "lunch" });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("type");
    }
  });
});

describe("validateChatMessageInput", () => {
  it("accepts a non-empty content string", () => {
    const result = validateChatMessageInput({ content: "今日は資料作成から始めます" });

    expect(result).toEqual({
      valid: true,
      data: { content: "今日は資料作成から始めます" },
    });
  });

  it("rejects a body that is not a JSON object", () => {
    const result = validateChatMessageInput("not an object");

    expect(result.valid).toBe(false);
  });

  it("rejects a missing content", () => {
    const result = validateChatMessageInput({});

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("content");
    }
  });

  it("rejects an empty (whitespace-only) content", () => {
    const result = validateChatMessageInput({ content: "   " });

    expect(result.valid).toBe(false);
  });

  it("rejects a non-string content", () => {
    const result = validateChatMessageInput({ content: 42 });

    expect(result.valid).toBe(false);
  });

  it("accepts a content at exactly the maximum length", () => {
    const result = validateChatMessageInput({ content: "あ".repeat(10_000) });

    expect(result.valid).toBe(true);
  });

  it("rejects a content longer than the maximum length", () => {
    const result = validateChatMessageInput({ content: "あ".repeat(10_001) });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("content");
    }
  });

  // Issue #376: replaceFromMessageId is optional — omitting it must keep the
  // pre-existing shape/behavior exactly (AC-8 の非回帰の一部). `toStrictEqual`
  // (not `toEqual`) on purpose: `toEqual` treats an explicit `undefined`
  // value the same as an absent key, so it would pass even if `data` grew a
  // `replaceFromMessageId: undefined` key — this test needs to prove the
  // *shape* is unchanged, not merely that present keys match.
  it("accepts a body without replaceFromMessageId (unchanged from before #376)", () => {
    const result = validateChatMessageInput({ content: "資料作成から始めます" });

    expect(result).toStrictEqual({
      valid: true,
      data: { content: "資料作成から始めます" },
    });
  });

  it("accepts a positive integer replaceFromMessageId and carries it through to data", () => {
    const result = validateChatMessageInput({
      content: "書き直した内容",
      replaceFromMessageId: 42,
    });

    expect(result).toEqual({
      valid: true,
      data: { content: "書き直した内容", replaceFromMessageId: 42 },
    });
  });

  // AC-9: a non-positive-integer replaceFromMessageId (string / 0 / negative
  // / decimal) must be rejected with the exact error message docs/features/
  // chat-message-rewrite.md's API table specifies (UI 側は code で分岐する
  // 400 応答なので、実装側でボディの error 文言まで固定する).
  it.each([
    ["a numeric string", "42"],
    ["zero", 0],
    ["a negative integer", -1],
    ["a decimal", 1.5],
  ])("rejects replaceFromMessageId that is %s (AC-9)", (_label, value) => {
    const result = validateChatMessageInput({
      content: "書き直した内容",
      replaceFromMessageId: value,
    });

    expect(result).toEqual({
      valid: false,
      error: "replaceFromMessageId must be a positive integer",
    });
  });

  // Issue #409（親 #276）AC-26〜AC-28: 随時メンタリングの mentoring フラグ。
  describe("mentoring", () => {
    it("accepts mentoring: true and carries it through to data (AC-26)", () => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: true,
      });

      expect(result).toEqual({
        valid: true,
        data: { content: "進め方を見てほしい", mentoring: true },
      });
    });

    // AC-27 の非回帰: mentoring を省略した body は、mentoring が無かった頃と
    // 完全に同じ shape のままであることを toStrictEqual で証明する
    // （replaceFromMessageId と同じ undefined-as-absent の作法）。
    it("accepts a body without mentoring (defaults to false, key omitted from data) (AC-27)", () => {
      const result = validateChatMessageInput({ content: "資料作成から始めます" });

      expect(result).toStrictEqual({
        valid: true,
        data: { content: "資料作成から始めます" },
      });
    });

    it("accepts mentoring: false explicitly, omitting the key from data (same as omitted)", () => {
      const result = validateChatMessageInput({
        content: "資料作成から始めます",
        mentoring: false,
      });

      expect(result).toStrictEqual({
        valid: true,
        data: { content: "資料作成から始めます" },
      });
    });

    it.each([
      ["a string", "true"],
      ["a number", 1],
      ["null", null],
    ])("rejects mentoring that is %s (AC-28)", (_label, value) => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: value,
      });

      expect(result).toEqual({
        valid: false,
        error: "mentoring must be a boolean",
      });
    });

    it("carries mentoring: true through alongside replaceFromMessageId", () => {
      const result = validateChatMessageInput({
        content: "書き直した内容",
        replaceFromMessageId: 42,
        mentoring: true,
      });

      expect(result).toEqual({
        valid: true,
        data: { content: "書き直した内容", replaceFromMessageId: 42, mentoring: true },
      });
    });
  });

  // Issue #471（親 #444 決定7）: mentoringTaskId の受理・検証。
  describe("mentoringTaskId", () => {
    it("accepts a positive integer mentoringTaskId alongside mentoring: true and carries it through to data (AC-12 非回帰)", () => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: true,
        mentoringTaskId: 7,
      });

      expect(result).toEqual({
        valid: true,
        data: { content: "進め方を見てほしい", mentoring: true, mentoringTaskId: 7 },
      });
    });

    // 非回帰: mentoringTaskId を省略した body は、mentoringTaskId が無かった
    // 頃と完全に同じ shape のまま（undefined-as-absent の作法）。
    it("accepts a body without mentoringTaskId, omitting the key from data (unchanged shape)", () => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: true,
      });

      expect(result).toStrictEqual({
        valid: true,
        data: { content: "進め方を見てほしい", mentoring: true },
      });
    });

    // AC-12: 0・負数・小数・文字列・真偽値はいずれも400（isPositiveInteger の再利用）。
    it.each([
      ["a numeric string", "7"],
      ["zero", 0],
      ["a negative integer", -1],
      ["a decimal", 1.5],
      ["a boolean", true],
    ])("rejects mentoringTaskId that is %s, even with mentoring: true (AC-12)", (_label, value) => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: true,
        mentoringTaskId: value,
      });

      expect(result).toEqual({
        valid: false,
        error: "mentoringTaskId must be a positive integer",
      });
    });

    // AC-13: mentoringTaskId があり mentoring: true が無いボディは400（無視しない）。
    it("rejects mentoringTaskId when mentoring is omitted entirely (AC-13)", () => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoringTaskId: 7,
      });

      expect(result).toEqual({
        valid: false,
        error: "mentoringTaskId requires mentoring: true",
      });
    });

    it("rejects mentoringTaskId when mentoring is explicitly false (AC-13)", () => {
      const result = validateChatMessageInput({
        content: "進め方を見てほしい",
        mentoring: false,
        mentoringTaskId: 7,
      });

      expect(result).toEqual({
        valid: false,
        error: "mentoringTaskId requires mentoring: true",
      });
    });

    it("carries mentoringTaskId through alongside replaceFromMessageId", () => {
      const result = validateChatMessageInput({
        content: "書き直した内容",
        replaceFromMessageId: 42,
        mentoring: true,
        mentoringTaskId: 7,
      });

      expect(result).toEqual({
        valid: true,
        data: {
          content: "書き直した内容",
          replaceFromMessageId: 42,
          mentoring: true,
          mentoringTaskId: 7,
        },
      });
    });
  });
});
