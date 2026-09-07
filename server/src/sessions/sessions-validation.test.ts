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
});
