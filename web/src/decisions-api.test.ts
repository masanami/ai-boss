import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDecisions, submitAppeal } from "./decisions-api";
import type {
  AppealSubmitResult,
  DecisionRecord,
  DecisionWithAppeals,
} from "./decision";

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

describe("submitAppeal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the content and returns the verdict result", async () => {
    const result: AppealSubmitResult = {
      appeal: {
        id: 1,
        decision_id: 1,
        content: "他を優先させてほしい",
        verdict: "upheld",
        response: "検討したが決定は維持する",
        created_at: "2026-07-05T00:00:00.000Z",
      },
      decision: SAMPLE_DECISION_RECORD,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(result),
    });
    vi.stubGlobal("fetch", fetchMock);

    const returned = await submitAppeal(1, "他を優先させてほしい");

    expect(returned).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/decisions/1/appeals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "他を優先させてほしい" }),
      }),
    );
  });

  it("throws with the server error message when the appeal fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({ error: "decision 1 is not active (status: revised)" }),
      }),
    );

    await expect(submitAppeal(1, "進言")).rejects.toThrow(
      "decision 1 is not active (status: revised)",
    );
  });
});
