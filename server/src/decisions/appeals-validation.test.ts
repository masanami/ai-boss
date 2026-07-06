import { describe, expect, it } from "vitest";
import { validateAppealInput } from "./appeals-validation.js";

describe("validateAppealInput", () => {
  it("rejects a non-object body", () => {
    const result = validateAppealInput("not an object");

    expect(result.valid).toBe(false);
  });

  it("rejects a body missing content", () => {
    const result = validateAppealInput({});

    expect(result).toEqual({
      valid: false,
      error: "content is required and must be a non-empty string",
    });
  });

  it("rejects an empty content string", () => {
    const result = validateAppealInput({ content: "   " });

    expect(result.valid).toBe(false);
  });

  it("accepts a valid content string", () => {
    const result = validateAppealInput({ content: "他の作業を優先させてほしい" });

    expect(result).toEqual({
      valid: true,
      data: { content: "他の作業を優先させてほしい" },
    });
  });
});
