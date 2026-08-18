import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorkLogView from "./WorkLogView";
import type { WorkLog } from "./work-log";

const TODAY = "2026-08-18";

const TODAY_LOG: WorkLog = {
  date: TODAY,
  content: "# 作業ログ 2026-08-18（火）\n\n- 09:05 着手: タスクA",
};

const PAST_LOG: WorkLog = {
  date: "2026-08-17",
  content: "# 作業ログ 2026-08-17（月）\n\n（記録なし）",
};

// 改行入りの本文は getByText の空白正規化と一致しないため、role="document"
// の textContent を直接比較する（DailyReportView.test.tsx と同じ作法）。
function currentLogContent(): string | null {
  return screen.getByRole("document", { name: "作業ログ本文" }).textContent;
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function routedFetchMock(logsByDate: Record<string, WorkLog>) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const match = /^\/api\/work-logs\/(.+)$/.exec(url);
    if (match && method === "GET") {
      const date = match[1];
      const log = logsByDate[date];
      if (log) {
        return jsonResponse(200, log);
      }
      return jsonResponse(400, {
        error: "日付は YYYY-MM-DD 形式で指定してください",
        code: "invalid_date",
      });
    }
    return Promise.reject(new Error(`unexpected fetch call: ${method} ${url}`));
  });
}

beforeEach(() => {
  // DailyReportView.test.tsx と同じパターン: Date のみ fake にする。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkLogView", () => {
  it("fetches and displays today's work log on mount", async () => {
    vi.stubGlobal("fetch", routedFetchMock({ [TODAY]: TODAY_LOG }));

    render(<WorkLogView />);

    await waitFor(() => expect(currentLogContent()).toBe(TODAY_LOG.content));
    expect(screen.getByLabelText("対象日")).toHaveValue(TODAY);
  });

  it("refetches and displays the selected date's work log when the date input changes", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetchMock({ [TODAY]: TODAY_LOG, [PAST_LOG.date]: PAST_LOG }),
    );

    render(<WorkLogView />);
    await waitFor(() => expect(currentLogContent()).toBe(TODAY_LOG.content));

    fireEvent.change(screen.getByLabelText("対象日"), {
      target: { value: PAST_LOG.date },
    });

    await waitFor(() => expect(currentLogContent()).toBe(PAST_LOG.content));
  });

  it("clears the previously loaded log while the newly selected date is still loading (PR #165 review)", async () => {
    let releasePastLog: (() => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url === `/api/work-logs/${TODAY}`) {
        return jsonResponse(200, TODAY_LOG);
      }
      // 過去日の応答は解放されるまで保留し、「読み込み中」の状態を作る
      return new Promise((resolve) => {
        releasePastLog = () => resolve(jsonResponse(200, PAST_LOG));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkLogView />);
    await waitFor(() => expect(currentLogContent()).toBe(TODAY_LOG.content));

    fireEvent.change(screen.getByLabelText("対象日"), {
      target: { value: PAST_LOG.date },
    });

    // 取得中に前日分が残っていると、日付入力と本文が食い違ったままコピーできてしまう
    await waitFor(() =>
      expect(
        screen.queryByRole("document", { name: "作業ログ本文" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /コピー/ })).toBeDisabled();

    releasePastLog?.();
    await waitFor(() => expect(currentLogContent()).toBe(PAST_LOG.content));
  });

  it("shows an error (role=alert) when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<WorkLogView />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("copies the work log content and shows a temporary success notification (role=status)", async () => {
    vi.stubGlobal("fetch", routedFetchMock({ [TODAY]: TODAY_LOG }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<WorkLogView />);
    await waitFor(() => expect(currentLogContent()).toBe(TODAY_LOG.content));

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("コピーしました"),
    );
    expect(writeText).toHaveBeenCalledWith(TODAY_LOG.content);
  });

  it("falls back to a selected textarea when the clipboard write fails (role=alert)", async () => {
    vi.stubGlobal("fetch", routedFetchMock({ [TODAY]: TODAY_LOG }));
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, "select");

    render(<WorkLogView />);
    await waitFor(() => expect(currentLogContent()).toBe(TODAY_LOG.content));

    fireEvent.click(screen.getByRole("button", { name: "コピー" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const textarea = screen.getByLabelText("作業ログ本文（手動コピー用）");
    expect(textarea).toHaveValue(TODAY_LOG.content);
    expect(selectSpy).toHaveBeenCalled();
  });

  it("disables the copy button until the work log is loaded", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<WorkLogView />);

    expect(screen.getByRole("button", { name: "コピー" })).toBeDisabled();
  });
});
