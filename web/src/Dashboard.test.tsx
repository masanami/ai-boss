import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import Dashboard from "./Dashboard";
import type { DashboardResponse } from "./dashboard-response";
import type { MeetingScheduleResponse } from "./meeting-schedule";

function makeDashboard(
  overrides: Partial<DashboardResponse> = {},
): DashboardResponse {
  return {
    progress: { done: 2, total: 5, ratio: 0.4 },
    morningSessionHeld: true,
    eveningSessionHeld: false,
    todayMaxEscalationLevel: 0,
    bossComment: "順調だ。この調子で進めろ。",
    date: "2026-07-06",
    ...overrides,
  };
}

/**
 * `Dashboard` はダッシュボード本体（`/api/dashboard`）に加え、今日の会の
 * 予定時刻セクション（`DashboardMeetingSchedule`、Issue #434）が
 * `/api/meeting-schedule/:date` を独立に読む。このファイルのテストは
 * ダッシュボード本体の表示だけを検証するため、後者には固定の非上書き値を
 * 返す最小限のスタブで応答する（決定9: 2つのセクションは別エンドポイント）。
 */
function makeMeetingSchedule(): MeetingScheduleResponse {
  return {
    date: "2026-07-06",
    morning: {
      time: "09:00",
      defaultTime: "09:00",
      overridden: false,
      latestAllowedTime: "12:00",
    },
    evening: {
      time: "18:00",
      defaultTime: "18:00",
      overridden: false,
      latestAllowedTime: "21:00",
    },
  };
}

function stubFetchOnce(dashboard: DashboardResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/meeting-schedule/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeMeetingSchedule()),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(dashboard),
      });
    }),
  );
}

describe("Dashboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading message while the dashboard is being fetched", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<Dashboard />);

    expect(screen.getByText("ダッシュボードを読み込み中…")).toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ダッシュボードの取得に失敗しました",
      ),
    );
  });

  it("renders the progress gauge with the done/total count and percentage", async () => {
    stubFetchOnce(makeDashboard({ progress: { done: 2, total: 5, ratio: 0.4 } }));

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByText("2 / 5 件完了（40%）")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("progressbar", { name: "今日の進捗" }),
    ).toHaveAttribute("aria-valuenow", "40");
  });

  it("colors the progress bar with the high-level accent when the ratio is high", async () => {
    stubFetchOnce(makeDashboard({ progress: { done: 4, total: 5, ratio: 0.8 } }));

    render(<Dashboard />);

    await waitFor(() =>
      expect(document.querySelector(".dashboard-progress-bar-fill")).toHaveClass(
        "dashboard-progress-bar-fill-high",
      ),
    );
  });

  it("colors the progress bar with the low-level accent when the ratio is low", async () => {
    stubFetchOnce(makeDashboard({ progress: { done: 0, total: 5, ratio: 0 } }));

    render(<Dashboard />);

    await waitFor(() =>
      expect(document.querySelector(".dashboard-progress-bar-fill")).toHaveClass(
        "dashboard-progress-bar-fill-low",
      ),
    );
  });

  it("renders the boss avatar and today's one-liner next to it", async () => {
    stubFetchOnce(makeDashboard({ bossComment: "今日も決めた通りにやれ" }));

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByText("今日も決めた通りにやれ")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("img", { name: /通常|満足|不機嫌|激励/ }),
    ).toBeInTheDocument();
  });

  it("resolves the boss's expression from the dashboard context (satisfied when ratio is high)", async () => {
    stubFetchOnce(
      makeDashboard({
        progress: { done: 9, total: 10, ratio: 0.9 },
        eveningSessionHeld: false,
        todayMaxEscalationLevel: 0,
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "満足" })).toBeInTheDocument(),
    );
  });

  it("resolves the boss's expression from the dashboard context (displeased when escalation overrides a high ratio)", async () => {
    stubFetchOnce(
      makeDashboard({
        progress: { done: 9, total: 10, ratio: 0.9 },
        eveningSessionHeld: true,
        todayMaxEscalationLevel: 2,
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "不機嫌" })).toBeInTheDocument(),
    );
  });

  it("resolves the boss's expression from the dashboard context (encouraging when morning session held and ratio is low)", async () => {
    stubFetchOnce(
      makeDashboard({
        progress: { done: 1, total: 10, ratio: 0.1 },
        morningSessionHeld: true,
        eveningSessionHeld: false,
        todayMaxEscalationLevel: 0,
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "激励" })).toBeInTheDocument(),
    );
  });

  it("resolves the boss's expression from the dashboard context (normal when no rule applies)", async () => {
    stubFetchOnce(makeDashboard());

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "通常" })).toBeInTheDocument(),
    );
  });

  it("resolves the boss's expression from the dashboard context (displeased via the evening-specific rule, proving eveningSessionHeld is wired independently of escalation)", async () => {
    stubFetchOnce(
      makeDashboard({
        progress: { done: 3, total: 10, ratio: 0.3 },
        eveningSessionHeld: true,
        todayMaxEscalationLevel: 0,
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "不機嫌" })).toBeInTheDocument(),
    );
  });

  it("resolves the boss's expression from the dashboard context (normal despite a low ratio when the morning session has not been held, proving morningSessionHeld is wired)", async () => {
    stubFetchOnce(
      makeDashboard({
        progress: { done: 1, total: 10, ratio: 0.1 },
        morningSessionHeld: false,
        eveningSessionHeld: false,
        todayMaxEscalationLevel: 0,
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "通常" })).toBeInTheDocument(),
    );
  });

  it("does not render the evening evaluation panel when the evening session has not been held", async () => {
    stubFetchOnce(makeDashboard({ eveningSessionHeld: false }));

    render(<Dashboard />);

    await waitFor(() =>
      expect(screen.getByText("2 / 5 件完了（40%）")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("region", { name: "夕会評価" }),
    ).not.toBeInTheDocument();
  });

  it("renders a praise-styled evening evaluation panel when the ratio is high", async () => {
    stubFetchOnce(
      makeDashboard({
        eveningSessionHeld: true,
        progress: { done: 8, total: 10, ratio: 0.8 },
      }),
    );

    render(<Dashboard />);

    const panel = await screen.findByRole("region", { name: "夕会評価" });
    expect(panel).toHaveClass("dashboard-evening-evaluation-praise");
  });

  it("renders a scold-styled evening evaluation panel when the ratio is low", async () => {
    stubFetchOnce(
      makeDashboard({
        eveningSessionHeld: true,
        progress: { done: 1, total: 10, ratio: 0.1 },
      }),
    );

    render(<Dashboard />);

    const panel = await screen.findByRole("region", { name: "夕会評価" });
    expect(panel).toHaveClass("dashboard-evening-evaluation-scold");
  });

  it("renders a neutral-styled evening evaluation panel when the ratio is in between", async () => {
    stubFetchOnce(
      makeDashboard({
        eveningSessionHeld: true,
        progress: { done: 6, total: 10, ratio: 0.6 },
      }),
    );

    render(<Dashboard />);

    const panel = await screen.findByRole("region", { name: "夕会評価" });
    expect(panel).toHaveClass("dashboard-evening-evaluation-neutral");
  });
});
