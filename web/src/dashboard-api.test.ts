import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDashboard } from "./dashboard-api";
import type { DashboardResponse } from "./dashboard-response";

const SAMPLE_DASHBOARD: DashboardResponse = {
  progress: { done: 2, total: 5, ratio: 0.4 },
  morningSessionHeld: true,
  eveningSessionHeld: false,
  todayMaxEscalationLevel: 0,
  bossComment: "順調だ。この調子で進めろ。",
  date: "2026-07-06",
};

describe("fetchDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed dashboard response when the request succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE_DASHBOARD),
      }),
    );

    const dashboard = await fetchDashboard();

    expect(dashboard).toEqual(SAMPLE_DASHBOARD);
  });

  it("throws with the server error message when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "internal error" }),
      }),
    );

    await expect(fetchDashboard()).rejects.toThrow("internal error");
  });
});
