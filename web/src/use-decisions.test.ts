import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDecisions } from "./use-decisions";
import type { DecisionRecord, DecisionWithAppeals } from "./decision";

const SAMPLE_DECISION_RECORD: DecisionRecord = {
  id: 1,
  session_id: 1,
  task_id: null,
  content: "資料作成を最優先にする",
  rationale: "締切が近いため",
  status: "active",
  created_at: "2026-07-05T00:00:00.000Z",
};

const SAMPLE_DECISION: DecisionWithAppeals = {
  ...SAMPLE_DECISION_RECORD,
  appeals: [],
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

  it("refetches the full decision list after a successful appeal", async () => {
    const refreshedList: DecisionWithAppeals[] = [
      {
        ...SAMPLE_DECISION,
        appeals: [
          {
            id: 1,
            decision_id: 1,
            content: "他を優先させてほしい",
            verdict: "upheld",
            response: "検討したが決定は維持する",
            created_at: "2026-07-05T01:00:00.000Z",
          },
        ],
      },
    ];
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_DECISION]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          appeal: refreshedList[0].appeals[0],
          decision: SAMPLE_DECISION_RECORD,
        }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(refreshedList),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDecisions());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.appeal(1, "他を優先させてほしい");
    });

    expect(result.current.decisions).toEqual(refreshedList);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("propagates the error and does not refetch when the appeal submission fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_DECISION]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({ error: "decision 1 is not active (status: revised)" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDecisions());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.appeal(1, "進言");
      }),
    ).rejects.toThrow("decision 1 is not active (status: revised)");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.decisions).toEqual([SAMPLE_DECISION]);
  });
});
