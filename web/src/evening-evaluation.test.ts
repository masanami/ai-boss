import { describe, expect, it } from "vitest";
import { resolveEveningEvaluationTone } from "./evening-evaluation";

describe("resolveEveningEvaluationTone", () => {
  it("returns praise when the ratio is 0.8 (boundary)", () => {
    expect(resolveEveningEvaluationTone(0.8)).toBe("praise");
  });

  it("returns praise when the ratio is above 0.8", () => {
    expect(resolveEveningEvaluationTone(1)).toBe("praise");
  });

  it("returns neutral when the ratio is just below 0.8", () => {
    expect(resolveEveningEvaluationTone(0.79)).toBe("neutral");
  });

  it("returns neutral when the ratio equals 0.5 (boundary)", () => {
    expect(resolveEveningEvaluationTone(0.5)).toBe("neutral");
  });

  it("returns scold when the ratio is just below 0.5", () => {
    expect(resolveEveningEvaluationTone(0.49)).toBe("scold");
  });

  it("returns scold when the ratio is 0", () => {
    expect(resolveEveningEvaluationTone(0)).toBe("scold");
  });
});
