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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));

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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));

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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));

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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
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

  it("calls the provided refreshTasks callback after a successful submitCheckin (Issue #134)", async () => {
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
    const refreshTasks = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useCheckinPanel(refreshTasks));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.submitCheckin({ type: "task_start", task_id: 1 });
    });

    expect(refreshTasks).toHaveBeenCalledTimes(1);
  });

  it("does not call refreshTasks when submitCheckin fails (Issue #134)", async () => {
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
    const refreshTasks = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useCheckinPanel(refreshTasks));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.submitCheckin({
        type: "task_start",
        task_id: 1,
      });
    });

    expect(refreshTasks).not.toHaveBeenCalled();
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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
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

  it("reloadEvents refetches today's activity and updates events (Issue #138)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([TASK_START_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.events).toEqual([]);

    await act(async () => {
      await result.current.reloadEvents();
    });

    expect(result.current.events).toEqual([TASK_START_EVENT]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale initial-load response that resolves after a later reloadEvents (Issue #138)", async () => {
    const staleEvent: ActivityEvent = { ...TASK_START_EVENT, id: 1 };
    const freshEvent: ActivityEvent = { ...TASK_START_EVENT, id: 2 };
    let resolveInitialLoad: (value: unknown) => void = () => {};
    const fetchMock = vi.fn();
    // 1回目（マウント時）: 保留にして後から解決させる
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitialLoad = resolve;
        }),
    );
    // 2回目（reloadEvents）: 即座に解決
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([freshEvent]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));

    await act(async () => {
      await result.current.reloadEvents();
    });
    expect(result.current.events).toEqual([freshEvent]);

    // 先行していたマウント時の初回読み込みが後から解決しても、新しい結果を
    // 巻き戻さない（use-tasks.ts の refresh と同様の世代ガード）。
    await act(async () => {
      resolveInitialLoad({
        ok: true,
        status: 200,
        json: () => Promise.resolve([staleEvent]),
      });
    });

    expect(result.current.events).toEqual([freshEvent]);
  });

  it("completeTask calls editTask, reloads events, and returns true on success (Issue #138)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([TASK_START_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const editTask = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completed = false;
    await act(async () => {
      completed = await result.current.completeTask(1, editTask);
    });

    expect(completed).toBe(true);
    expect(editTask).toHaveBeenCalledWith(1, { status: "done" });
    expect(result.current.events).toEqual([TASK_START_EVENT]);
    expect(result.current.submitError).toBeNull();
  });

  it("sets submitError and returns false when completeTask's editTask rejects (Issue #138)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );
    const editTask = vi.fn().mockRejectedValue(new Error("task 1 not found"));

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completed = true;
    await act(async () => {
      completed = await result.current.completeTask(1, editTask);
    });

    expect(completed).toBe(false);
    expect(result.current.submitError).toBe("task 1 not found");
  });

  it("ignores a second completeTask call while one is in flight (double-click guard, Issue #138)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );
    let releaseEditTask: (() => void) | undefined;
    const editTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseEditTask = () => resolve(undefined);
        }),
    );

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first: Promise<boolean> | undefined;
    let second = true;
    await act(async () => {
      first = result.current.completeTask(1, editTask);
      second = await result.current.completeTask(1, editTask);
      releaseEditTask?.();
      await first;
    });

    expect(second).toBe(false);
    expect(await first).toBe(true);
    expect(editTask).toHaveBeenCalledTimes(1);
  });

  it("blocks submitCheckin while completeTask is in flight (Issue #138)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );
    let releaseEditTask: (() => void) | undefined;
    const editTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseEditTask = () => resolve(undefined);
        }),
    );

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let completePromise: Promise<boolean> | undefined;
    let submitResult = true;
    await act(async () => {
      completePromise = result.current.completeTask(1, editTask);
      submitResult = await result.current.submitCheckin({ type: "break_end" });
      releaseEditTask?.();
      await completePromise;
    });

    expect(submitResult).toBe(false);
    expect(await completePromise).toBe(true);
  });

  it("blocks completeTask while submitCheckin is in flight (Issue #138)", async () => {
    const fetchMock = vi.fn();
    // マウント時の GET /api/activity/today
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    // submitCheckin の POST /api/checkins は解放されるまで完了しない
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
    // submitCheckin 成功後の再取得
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([TASK_START_EVENT]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const editTask = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let submitPromise: Promise<boolean> | undefined;
    let completeResult = true;
    await act(async () => {
      submitPromise = result.current.submitCheckin({ type: "break_end" });
      completeResult = await result.current.completeTask(1, editTask);
      releasePost?.();
      await submitPromise;
    });

    expect(completeResult).toBe(false);
    expect(editTask).not.toHaveBeenCalled();
    expect(await submitPromise).toBe(true);
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

    const { result } = renderHook(() => useCheckinPanel(vi.fn()));
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
