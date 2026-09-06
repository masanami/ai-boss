import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDecisions } from "./use-decisions";
import type { DecisionRecord } from "./decision";

const SAMPLE_DECISION: DecisionRecord = {
  id: 1,
  session_id: 1,
  task_id: null,
  task_title: null,
  content: "資料作成を最優先にする",
  rationale: "締切が近いため",
  status: "active",
  kind: "decision",
  created_at: "2026-07-05T00:00:00.000Z",
};

describe("useDecisions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the decision list on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([SAMPLE_DECISION]),
      }),
    );

    const { result } = renderHook(() => useDecisions());

    await waitFor(() =>
      expect(result.current.decisions).toEqual([SAMPLE_DECISION]),
    );
    expect(result.current.status).toBe("ready");
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useDecisions());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.decisions).toEqual([]);
  });

  it("exposes no appeal action — the appeals path was removed (#358/#397)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([SAMPLE_DECISION]),
      }),
    );

    const { result } = renderHook(() => useDecisions());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).not.toHaveProperty("appeal");
  });
});
