import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMeetingSchedule } from "./use-meeting-schedule";
import type { MeetingScheduleResponse } from "./meeting-schedule";

const TODAY = "2026-09-20";

const SAMPLE_SCHEDULE: MeetingScheduleResponse = {
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
};

beforeEach(() => {
  // Date のみを fake にする（実タイマーは動かしたまま）。RTL の `waitFor` は
  // 内部で実タイマーに依存するため、useFakeTimers() で丸ごと差し替えると
  // waitFor が解決しなくなる（use-daily-reports.test.ts の既存パターンを踏襲）。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 20, 10, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMeetingSchedule", () => {
  it("fetches today's schedule on mount using the local date key and sets status ready", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMeetingSchedule());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.schedule).toEqual(SAMPLE_SCHEDULE);
    expect(fetchMock).toHaveBeenCalledWith(`/api/meeting-schedule/${TODAY}`);
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useMeetingSchedule());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.schedule).toBeNull();
  });

  it("saves a patch and replaces schedule with the PUT response without re-fetching via GET", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    const updated: MeetingScheduleResponse = {
      ...SAMPLE_SCHEDULE,
      evening: {
        time: "21:00",
        defaultTime: "18:00",
        overridden: true,
        latestAllowedTime: "21:00",
      },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMeetingSchedule());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveSchedule({ evening: "21:00" });
    });

    expect(saved).toBe(true);
    expect(result.current.schedule).toEqual(updated);
    expect(result.current.saveError).toBeNull();
    // GET (mount) + PUT だけ。PUT 後に GET を撃ち直さない（決定9・AC-47）。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/meeting-schedule/${TODAY}`,
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sets saveError and returns false when the save fails, keeping the previous schedule", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({ error: "夕会の時刻は 21:00 より後には設定できません", code: "delay_limit_exceeded" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMeetingSchedule());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let saved = true;
    await act(async () => {
      saved = await result.current.saveSchedule({ evening: "23:00" });
    });

    expect(saved).toBe(false);
    expect(result.current.saveError).toBe(
      "夕会の時刻は 21:00 より後には設定できません",
    );
    expect(result.current.schedule).toEqual(SAMPLE_SCHEDULE);
  });

  it("sets isSaving true while a save is in flight", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_SCHEDULE),
    });
    let releaseSave: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () =>
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(SAMPLE_SCHEDULE),
            });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMeetingSchedule());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let savePromise: Promise<boolean> | undefined;
    act(() => {
      savePromise = result.current.saveSchedule({ morning: "08:00" });
    });

    await waitFor(() => expect(result.current.isSaving).toBe(true));

    await act(async () => {
      releaseSave?.();
      await savePromise;
    });

    expect(result.current.isSaving).toBe(false);
  });
});
