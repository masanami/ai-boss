import { describe, expect, it } from "vitest";
import { resolveProgressLevel } from "./dashboard-progress-level";

describe("resolveProgressLevel", () => {
  it("returns low when the ratio is just below the encouraging threshold (0.3)", () => {
    expect(resolveProgressLevel(0.29)).toBe("low");
  });

  it("returns mid when the ratio equals the encouraging threshold (0.3, boundary)", () => {
    expect(resolveProgressLevel(0.3)).toBe("mid");
  });

  it("returns mid when the ratio is between the thresholds", () => {
    expect(resolveProgressLevel(0.5)).toBe("mid");
  });

  it("returns high when the ratio equals the satisfied threshold (0.8, boundary)", () => {
    expect(resolveProgressLevel(0.8)).toBe("high");
  });

  it("returns high when the ratio is above the satisfied threshold", () => {
    expect(resolveProgressLevel(1)).toBe("high");
  });
});
