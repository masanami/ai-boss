import { describe, expect, it } from "vitest";
import { validateCreateSessionInput } from "./sessions-validation.js";

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
