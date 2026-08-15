import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDailyReports } from "./use-daily-reports";
import type { DailyReport, DailyReportSummary } from "./daily-report";

const TODAY = "2026-08-14";

const TODAY_SUMMARY: DailyReportSummary = {
  date: TODAY,
  created_at: "2026-08-14T10:30:00.000Z",
  updated_at: "2026-08-14T10:35:00.000Z",
};

const TODAY_REPORT: DailyReport = {
  ...TODAY_SUMMARY,
  id: 1,
  content: "# 日報 2026-08-14（金）\n",
  evening_session_id: 12,
};

const PAST_SUMMARY: DailyReportSummary = {
  date: "2026-08-13",
  created_at: "2026-08-13T10:30:00.000Z",
  updated_at: "2026-08-13T10:35:00.000Z",
};

const PAST_REPORT: DailyReport = {
  ...PAST_SUMMARY,
  id: 2,
  content: "# 日報 2026-08-13（木）\n",
  evening_session_id: 11,
};

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function routedFetchMock(handlers: {
  today?: () => Promise<unknown>;
  summaries?: () => Promise<unknown>;
  byDate?: Record<string, () => Promise<unknown>>;
  generate?: () => Promise<unknown>;
}) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/reports" && method === "GET") {
      return handlers.summaries
        ? handlers.summaries()
        : jsonResponse(200, []);
    }
    if (url === "/api/reports/generate" && method === "POST") {
      return handlers.generate
        ? handlers.generate()
        : Promise.reject(new Error("unexpected generate call"));
    }
    const match = /^\/api\/reports\/(.+)$/.exec(url);
    if (match && method === "GET") {
      const date = match[1];
      if (date === TODAY && handlers.today) {
        return handlers.today();
      }
      if (handlers.byDate?.[date]) {
        return handlers.byDate[date]();
      }
      return jsonResponse(404, {
        error: `report for ${date} not found`,
        code: "report_not_found",
      });
    }
    return Promise.reject(new Error(`unexpected fetch call: ${method} ${url}`));
  });
}

beforeEach(() => {
  // Date のみを fake にする（実タイマーは動かしたまま）。RTL の `waitFor` は
  // 内部で実タイマーに依存するため、useFakeTimers() で丸ごと差し替えると
  // waitFor が解決しなくなる（use-chat.test.ts の既存パターンを踏襲）。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDailyReports", () => {
  it("loads today's report and the past summaries on mount", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY, PAST_SUMMARY]),
      }),
    );

    const { result } = renderHook(() => useDailyReports());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.report).toEqual(TODAY_REPORT);
    expect(result.current.summaries).toEqual([TODAY_SUMMARY, PAST_SUMMARY]);
    expect(result.current.needsEveningSession).toBe(false);
    expect(result.current.selectedDate).toBe(TODAY);
  });

  it("shows the evening-session-required state when today's report doesn't exist yet (404)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        summaries: () => jsonResponse(200, [PAST_SUMMARY]),
      }),
    );

    const { result } = renderHook(() => useDailyReports());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.report).toBeNull();
    expect(result.current.needsEveningSession).toBe(true);
  });

  it("sets an error status when the initial summaries fetch fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useDailyReports());

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("selects a past date and switches the displayed report content", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY, PAST_SUMMARY]),
        byDate: { [PAST_SUMMARY.date]: () => jsonResponse(200, PAST_REPORT) },
      }),
    );

    const { result } = renderHook(() => useDailyReports());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      result.current.selectDate(PAST_SUMMARY.date);
    });

    await waitFor(() =>
      expect(result.current.report).toEqual(PAST_REPORT),
    );
    expect(result.current.selectedDate).toBe(PAST_SUMMARY.date);
    expect(result.current.needsEveningSession).toBe(false);
  });

  it("keeps the later selection's report when an earlier selection's response resolves after it (stale-response guard)", async () => {
    const DATE_A = "2026-08-12";
    const DATE_B = PAST_SUMMARY.date; // "2026-08-13"
    const REPORT_A: DailyReport = {
      ...PAST_REPORT,
      date: DATE_A,
      content: "# 日報 2026-08-12（水）\n",
    };

    let resolveA: (() => void) | null = null;
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY, PAST_SUMMARY]),
        byDate: {
          [DATE_A]: () => pendingA.then(() => jsonResponse(200, REPORT_A)),
          [DATE_B]: () => jsonResponse(200, PAST_REPORT),
        },
      }),
    );

    const { result } = renderHook(() => useDailyReports());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // A を選ぶ（応答はまだ保留）。続けて B を選ぶ（先に解決する）。その後で
    // A の応答を解決させても、最後に選んだ B のままであるべき。
    await act(async () => {
      result.current.selectDate(DATE_A);
    });
    await act(async () => {
      result.current.selectDate(DATE_B);
    });

    await waitFor(() => expect(result.current.report).toEqual(PAST_REPORT));

    await act(async () => {
      resolveA?.();
      await pendingA;
    });

    expect(result.current.report).toEqual(PAST_REPORT);
    expect(result.current.selectedDate).toBe(DATE_B);
  });

  it("regenerates the report, updating both the content and the summary list without duplicating the date", async () => {
    const regenerated: DailyReport = {
      ...TODAY_REPORT,
      content: "# 日報 2026-08-14（金）\n更新後\n",
      updated_at: "2026-08-14T11:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY, PAST_SUMMARY]),
        generate: () => jsonResponse(200, regenerated),
      }),
    );

    const { result } = renderHook(() => useDailyReports());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.regenerate();
    });

    expect(result.current.report).toEqual(regenerated);
    expect(result.current.summaries).toHaveLength(2);
    expect(
      result.current.summaries.filter((s) => s.date === TODAY),
    ).toHaveLength(1);
    expect(result.current.summaries[0]).toEqual({
      date: regenerated.date,
      created_at: regenerated.created_at,
      updated_at: regenerated.updated_at,
    });
  });

  it("surfaces the evening-session-required state when regenerate fails with a 409", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        summaries: () => jsonResponse(200, []),
        generate: () =>
          jsonResponse(409, {
            error: "夕会を完了すると日報を生成できます",
            code: "evening_session_required",
          }),
      }),
    );

    const { result } = renderHook(() => useDailyReports());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.regenerate();
    });

    expect(result.current.needsEveningSession).toBe(true);
    expect(result.current.report).toBeNull();
  });
});
