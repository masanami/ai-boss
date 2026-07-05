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
});
