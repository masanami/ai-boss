import { describe, expect, it } from "vitest";
import { resolveBossExpression } from "./boss-expression";
import type { BossExpressionContext } from "./boss-expression";

function makeContext(
  overrides: Partial<BossExpressionContext> = {},
): BossExpressionContext {
  return {
    progressRatio: 0.5,
    morningSessionHeld: false,
    eveningSessionHeld: false,
    todayMaxEscalationLevel: 0,
    ...overrides,
  };
}

describe("resolveBossExpression", () => {
  it("returns displeased when the escalation level is 2 (boundary)", () => {
    const context = makeContext({ todayMaxEscalationLevel: 2 });
    expect(resolveBossExpression(context)).toBe("displeased");
  });

  it("returns displeased when the escalation level is above 2", () => {
    const context = makeContext({ todayMaxEscalationLevel: 3 });
    expect(resolveBossExpression(context)).toBe("displeased");
  });

  it("does not trigger the escalation rule when the level is just below the threshold", () => {
    const context = makeContext({ todayMaxEscalationLevel: 1 });
    expect(resolveBossExpression(context)).toBe("normal");
  });

  it("returns satisfied when the evening session is held and progress ratio is 0.8 (boundary)", () => {
    const context = makeContext({
      eveningSessionHeld: true,
      progressRatio: 0.8,
    });
    expect(resolveBossExpression(context)).toBe("satisfied");
  });

  it("does not trigger the evening-satisfied rule when progress ratio is just below 0.8", () => {
    const context = makeContext({
      eveningSessionHeld: true,
      progressRatio: 0.79,
    });
    expect(resolveBossExpression(context)).toBe("normal");
  });

  it("does not trigger the evening-displeased rule when progress ratio equals 0.5 (boundary)", () => {
    const context = makeContext({
      eveningSessionHeld: true,
      progressRatio: 0.5,
    });
    expect(resolveBossExpression(context)).toBe("normal");
  });

  it("returns displeased when the evening session is held and progress ratio is just below 0.5", () => {
    const context = makeContext({
      eveningSessionHeld: true,
      progressRatio: 0.49,
    });
    expect(resolveBossExpression(context)).toBe("displeased");
  });

  it("returns satisfied when progress ratio is 0.9 even without an evening session", () => {
    const context = makeContext({
      eveningSessionHeld: false,
      progressRatio: 0.9,
    });
    expect(resolveBossExpression(context)).toBe("satisfied");
  });

  it("returns encouraging when the morning session is held and progress ratio is just below 0.3", () => {
    const context = makeContext({
      morningSessionHeld: true,
      eveningSessionHeld: false,
      progressRatio: 0.29,
    });
    expect(resolveBossExpression(context)).toBe("encouraging");
  });

  it("does not trigger the encouraging rule when progress ratio equals 0.3 (boundary)", () => {
    const context = makeContext({
      morningSessionHeld: true,
      progressRatio: 0.3,
    });
    expect(resolveBossExpression(context)).toBe("normal");
  });

  it("returns normal when no rule matches", () => {
    const context = makeContext();
    expect(resolveBossExpression(context)).toBe("normal");
  });

  it("prioritizes the escalation rule over the evening-satisfied rule", () => {
    const context = makeContext({
      todayMaxEscalationLevel: 2,
      eveningSessionHeld: true,
      progressRatio: 0.9,
    });
    expect(resolveBossExpression(context)).toBe("displeased");
  });

  it("prioritizes the evening-displeased rule over the encouraging rule", () => {
    const context = makeContext({
      morningSessionHeld: true,
      eveningSessionHeld: true,
      progressRatio: 0.2,
    });
    expect(resolveBossExpression(context)).toBe("displeased");
  });
});
