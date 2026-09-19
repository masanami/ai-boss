import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import DashboardMeetingSchedule from "./DashboardMeetingSchedule";
import type { MeetingScheduleResponse } from "./meeting-schedule";

/**
 * `within(container)` を使い、このテストが描画した DOM だけを対象にクエリ
 * する。グローバルな `screen`（`document.body` 全体を見る）だと、他ファイル
 * との並行実行時にまれに前のテストの後片付けタイミングと競合し、
 * 「複数要素が見つかる」偽陽性を招くことがある（実測）。`render` の戻り値の
 * `container` はこのテストの `render` 呼び出し専用なので、この種の競合の
 * 影響を受けない。
 */
function renderScoped() {
  const { container, ...rest } = render(<DashboardMeetingSchedule />);
  return { ...rest, scope: within(container) };
}

const TODAY = "2026-09-20";

function makeSchedule(
  overrides: Partial<MeetingScheduleResponse> = {},
): MeetingScheduleResponse {
  return {
    date: TODAY,
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
    ...overrides,
  };
}

function stubGet(schedule: MeetingScheduleResponse) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve(schedule),
  });
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DashboardMeetingSchedule", () => {
  it("renders the section landmark with the required aria-label and heading", async () => {
    vi.stubGlobal("fetch", stubGet(makeSchedule()));

    const { scope } = renderScoped();

    expect(
      await scope.findByRole("region", { name: "今日の会の予定時刻" }),
    ).toBeInTheDocument();
    expect(scope.getByText("今日の会")).toBeInTheDocument();
  });

  it("shows today's effective morning meeting time (AC-42)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet(
        makeSchedule({
          morning: {
            time: "09:00",
            defaultTime: "09:00",
            overridden: false,
            latestAllowedTime: "12:00",
          },
        }),
      ),
    );

    const { scope } = renderScoped();

    expect(await scope.findByText("朝会 09:00")).toBeInTheDocument();
  });

  it("shows today's effective evening meeting time (AC-43)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet(
        makeSchedule({
          evening: {
            time: "21:00",
            defaultTime: "18:00",
            overridden: true,
            latestAllowedTime: "21:00",
          },
        }),
      ),
    );

    const { scope } = renderScoped();

    expect(await scope.findByText("夕会 21:00")).toBeInTheDocument();
  });

  it("shows the override note for an overridden slot (AC-44)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet(
        makeSchedule({
          evening: {
            time: "21:00",
            defaultTime: "18:00",
            overridden: true,
            latestAllowedTime: "21:00",
          },
        }),
      ),
    );

    const { scope } = renderScoped();

    expect(
      await scope.findByText("（既定 18:00 から変更）"),
    ).toBeInTheDocument();
  });

  it("does not show the override note for a non-overridden slot (AC-45)", async () => {
    vi.stubGlobal("fetch", stubGet(makeSchedule()));

    const { scope } = renderScoped();

    await scope.findByText("朝会 09:00");
    expect(scope.queryByText(/既定.*から変更/)).not.toBeInTheDocument();
  });

  it("sets the time input's max attribute to latestAllowedTime (AC-46, jsdom does not enforce max as a constraint so this asserts the attribute value directly)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet(
        makeSchedule({
          evening: {
            time: "18:00",
            defaultTime: "18:00",
            overridden: false,
            latestAllowedTime: "21:00",
          },
        }),
      ),
    );

    const { scope } = renderScoped();

    await waitFor(() =>
      expect(scope.getByLabelText("朝会")).toHaveAttribute("max", "12:00"),
    );
    expect(scope.getByLabelText("夕会")).toHaveAttribute("max", "21:00");
  });

  it("updates the displayed effective time from the save response on success (AC-47), without re-fetching via GET", async () => {
    const fetchMock = stubGet(makeSchedule());
    const updated = makeSchedule({
      evening: {
        time: "21:00",
        defaultTime: "18:00",
        overridden: true,
        latestAllowedTime: "21:00",
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { scope } = renderScoped();
    await scope.findByText("夕会 18:00");

    fireEvent.change(scope.getByLabelText("夕会"), {
      target: { value: "21:00" },
    });
    fireEvent.click(scope.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(scope.getByText("夕会 21:00")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/meeting-schedule/${TODAY}`,
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("shows a role=alert error when saving fails (AC-48)", async () => {
    const fetchMock = stubGet(makeSchedule());
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          error: "夕会の時刻は 21:00 より後には設定できません",
          code: "delay_limit_exceeded",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { scope } = renderScoped();
    await scope.findByText("夕会 18:00");

    fireEvent.change(scope.getByLabelText("夕会"), {
      target: { value: "23:00" },
    });
    fireEvent.click(scope.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(scope.getByRole("alert")).toHaveTextContent(
        "夕会の時刻は 21:00 より後には設定できません",
      ),
    );
  });

  it("shows a reset-to-default action for an overridden slot (AC-49)", async () => {
    vi.stubGlobal(
      "fetch",
      stubGet(
        makeSchedule({
          evening: {
            time: "21:00",
            defaultTime: "18:00",
            overridden: true,
            latestAllowedTime: "21:00",
          },
        }),
      ),
    );

    const { scope } = renderScoped();

    expect(
      await scope.findByRole("button", { name: "夕会を既定に戻す" }),
    ).toBeInTheDocument();
  });

  it("does not show a reset-to-default action for a non-overridden slot (AC-50)", async () => {
    vi.stubGlobal("fetch", stubGet(makeSchedule()));

    const { scope } = renderScoped();

    await scope.findByText("朝会 09:00");
    expect(
      scope.queryByRole("button", { name: "朝会を既定に戻す" }),
    ).not.toBeInTheDocument();
    expect(
      scope.queryByRole("button", { name: "夕会を既定に戻す" }),
    ).not.toBeInTheDocument();
  });

  it("resets the effective time to the default when reset-to-default is clicked (AC-51)", async () => {
    const fetchMock = stubGet(
      makeSchedule({
        evening: {
          time: "21:00",
          defaultTime: "18:00",
          overridden: true,
          latestAllowedTime: "21:00",
        },
      }),
    );
    const reset = makeSchedule();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(reset),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { scope } = renderScoped();
    await scope.findByText("夕会 21:00");

    fireEvent.click(scope.getByRole("button", { name: "夕会を既定に戻す" }));

    await waitFor(() =>
      expect(scope.getByText("夕会 18:00")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/meeting-schedule/${TODAY}`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ evening: null }),
      }),
    );
  });
});
