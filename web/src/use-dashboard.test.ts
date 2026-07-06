import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDashboard } from "./use-dashboard";
import type { DashboardResponse } from "./dashboard-response";

const SAMPLE_DASHBOARD: DashboardResponse = {
  progress: { done: 2, total: 5, ratio: 0.4 },
  morningSessionHeld: true,
  eveningSessionHeld: false,
  todayMaxEscalationLevel: 0,
  bossComment: "順調だ。この調子で進めろ。",
  date: "2026-07-06",
};

describe("useDashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the dashboard on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE_DASHBOARD),
      }),
    );

    const { result } = renderHook(() => useDashboard());

    await waitFor(() =>
      expect(result.current.dashboard).toEqual(SAMPLE_DASHBOARD),
    );
    expect(result.current.status).toBe("ready");
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.dashboard).toBeNull();
  });
});
