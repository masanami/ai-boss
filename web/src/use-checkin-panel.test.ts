import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCheckinPanel } from "./use-checkin-panel";
import type { ActivityEvent } from "./activity-event";

const TASK_START_EVENT: ActivityEvent = {
  id: 1,
  type: "task_start",
  task_id: 1,
  note: null,
  expected_minutes: null,
  created_at: "2026-07-06T00:00:00.000Z",
};

const BREAK_START_EVENT: ActivityEvent = {
  id: 2,
  type: "break_start",
  task_id: null,
  note: null,
  expected_minutes: 15,
  created_at: "2026-07-06T00:05:00.000Z",
};

describe("useCheckinPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads today's activity events on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([TASK_START_EVENT]),
      }),
    );

    const { result } = renderHook(() => useCheckinPanel());

    await waitFor(() =>
      expect(result.current.events).toEqual([TASK_START_EVENT]),
    );
    expect(result.current.status).toBe("ready");
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useCheckinPanel());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.events).toEqual([]);
  });

  it("derives isOnBreak from the loaded events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([TASK_START_EVENT, BREAK_START_EVENT]),
      }),
    );

    const { result } = renderHook(() => useCheckinPanel());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.isOnBreak).toBe(true);
  });

  it("refetches events and returns true after a successful submitCheckin", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(TASK_START_EVENT),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([TASK_START_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckinPanel());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let submitted = false;
    await act(async () => {
      submitted = await result.current.submitCheckin({
        type: "task_start",
        task_id: 1,
      });
    });

    expect(submitted).toBe(true);
    expect(result.current.events).toEqual([TASK_START_EVENT]);
    expect(result.current.submitError).toBeNull();
  });

  it("ignores a second submitCheckin while one is in flight (double-submit guard)", async () => {
    const fetchMock = vi.fn();
    // 初回マウント時の GET /api/activity/today
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    // 1 回目の POST は解放されるまで完了しない
    let releasePost: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePost = () =>
            resolve({
              ok: true,
              status: 201,
              json: () => Promise.resolve(TASK_START_EVENT),
            });
        }),
    );
    // 1 回目成功後の再取得
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([TASK_START_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckinPanel());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first: Promise<boolean> | undefined;
    let second = true;
    await act(async () => {
      first = result.current.submitCheckin({ type: "break_end" });
      second = await result.current.submitCheckin({ type: "break_end" });
      releasePost?.();
      await first;
    });

    expect(second).toBe(false);
    expect(await first).toBe(true);
    // マウント時 GET + 1 回目 POST + 再取得 = 3 回のみ（2 回目はリクエストなし）
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sets submitError and returns false when submitCheckin fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "task 1 not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckinPanel());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let submitted = true;
    await act(async () => {
      submitted = await result.current.submitCheckin({
        type: "task_start",
        task_id: 1,
      });
    });

    expect(submitted).toBe(false);
    expect(result.current.submitError).toBe("task 1 not found");
  });
});
