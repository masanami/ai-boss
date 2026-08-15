import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DailyReportView from "./DailyReportView";
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
  content: "# 日報 2026-08-14（金）\n\n## 本日のタスク\n",
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
  content: "# 日報 2026-08-13（木）\n\n## 本日のタスク\n",
  evening_session_id: 11,
};

// screen.getByText() の既定ノーマライザーは連続する空白（改行含む）を1つに
// 畳んでしまい、改行入りの日報本文とは一致しない。role="document" の要素の
// textContent を直接（正規化なしで）比較する。
function currentReportContent(): string | null {
  return screen.getByRole("document", { name: "日報本文" }).textContent;
}

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
      return handlers.summaries ? handlers.summaries() : jsonResponse(200, []);
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
  // use-chat.test.ts と同じパターン: Date のみ fake にする（waitFor が実タイマー
  // に依存するため丸ごとの useFakeTimers() は使わない）。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DailyReportView", () => {
  it("shows the evening-session-required hint when today's report doesn't exist yet", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({ summaries: () => jsonResponse(200, []) }),
    );

    render(<DailyReportView />);

    await waitFor(() =>
      expect(
        screen.getByText("夕会を完了すると日報を生成できます"),
      ).toBeInTheDocument(),
    );
  });

  it("displays today's report content as raw markdown text", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY]),
      }),
    );

    render(<DailyReportView />);

    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );
  });

  it("copies the report content and shows a temporary success notification (role=status)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY]),
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("コピーしました"),
    );
    expect(writeText).toHaveBeenCalledWith(TODAY_REPORT.content);
  });

  it("falls back to a selected textarea when the clipboard write fails (role=alert)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY]),
      }),
    );
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, "select");

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const textarea = screen.getByLabelText("日報本文（手動コピー用）");
    expect(textarea).toHaveValue(TODAY_REPORT.content);
    expect(selectSpy).toHaveBeenCalled();
  });

  it("falls back to a selected textarea when navigator.clipboard is undefined (non-secure context)", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY]),
      }),
    );
    // 非セキュアコンテキストでは navigator.clipboard 自体が undefined になり、
    // .writeText を呼ぶと同期的に TypeError が投げられる（CodeRabbit 指摘）。
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, "select");

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "コピー" })),
    ).not.toThrow();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const textarea = screen.getByLabelText("日報本文（手動コピー用）");
    expect(textarea).toHaveValue(TODAY_REPORT.content);
    expect(selectSpy).toHaveBeenCalled();
  });

  it("retries the copy on a second click of the copy button after a failure", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY]),
      }),
    );
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("コピーしました"),
    );
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("regenerates the report and updates both the content and the past list without duplicating today's date", async () => {
    const regenerated: DailyReport = {
      ...TODAY_REPORT,
      content: "# 日報 2026-08-14（金）\n\n更新後の内容\n",
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

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    fireEvent.click(screen.getByRole("button", { name: "再生成" }));

    await waitFor(() =>
      expect(currentReportContent()).toBe(regenerated.content),
    );
    // 同一日付 (TODAY) がボタンとして重複していないこと
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.textContent === TODAY),
    ).toHaveLength(1);
  });

  it("shows the evening-session-required hint when regenerate fails with a 409", async () => {
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

    render(<DailyReportView />);
    await waitFor(() =>
      expect(
        screen.getByText("夕会を完了すると日報を生成できます"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "再生成" }));

    await waitFor(() =>
      expect(
        screen.getByText("夕会を完了すると日報を生成できます"),
      ).toBeInTheDocument(),
    );
  });

  it("switches the displayed content when a past date is selected from the list", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({
        today: () => jsonResponse(200, TODAY_REPORT),
        summaries: () => jsonResponse(200, [TODAY_SUMMARY, PAST_SUMMARY]),
        byDate: { [PAST_SUMMARY.date]: () => jsonResponse(200, PAST_REPORT) },
      }),
    );

    render(<DailyReportView />);
    await waitFor(() =>
      expect(currentReportContent()).toBe(TODAY_REPORT.content),
    );

    fireEvent.click(screen.getByRole("button", { name: PAST_SUMMARY.date }));

    await waitFor(() =>
      expect(currentReportContent()).toBe(PAST_REPORT.content),
    );
  });
});
