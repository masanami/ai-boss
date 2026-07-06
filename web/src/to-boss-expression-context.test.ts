import { describe, expect, it } from "vitest";
import { toBossExpressionContext } from "./to-boss-expression-context";
import type { DashboardResponse } from "./dashboard-response";

describe("toBossExpressionContext", () => {
  it("maps the dashboard response fields to the boss expression context", () => {
    const dashboard: DashboardResponse = {
      progress: { done: 3, total: 4, ratio: 0.75 },
      morningSessionHeld: true,
      eveningSessionHeld: false,
      todayMaxEscalationLevel: 1,
      bossComment: "あと少しだ",
      date: "2026-07-06",
    };

    expect(toBossExpressionContext(dashboard)).toEqual({
      progressRatio: 0.75,
      morningSessionHeld: true,
      eveningSessionHeld: false,
      todayMaxEscalationLevel: 1,
    });
  });
});
