import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDecisions } from "./decisions-api";
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

describe("fetchDecisions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed decision list when the request succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_DECISION]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const decisions = await fetchDecisions();

    expect(decisions).toEqual([SAMPLE_DECISION]);
    expect(fetchMock).toHaveBeenCalledWith("/api/decisions");
  });

  it("carries task_title and kind through from the response", async () => {
    const withTask: DecisionRecord = {
      ...SAMPLE_DECISION,
      task_id: 5,
      task_title: "見積もり資料の作成",
      kind: "mentoring",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([withTask]),
      }),
    );

    const [decision] = await fetchDecisions();

    expect(decision.task_title).toBe("見積もり資料の作成");
    expect(decision.kind).toBe("mentoring");
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

    await expect(fetchDecisions()).rejects.toThrow("internal error");
  });
});
