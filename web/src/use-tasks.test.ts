import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTasks } from "./use-tasks";
import type { Task } from "./task";

const SAMPLE_TASK: Task = {
  id: 1,
  title: "資料を作る",
  description: null,
  category: "work",
  priority: null,
  due_at: null,
  status: "todo",
  boss_comment: null,
  estimated_minutes: null,
  created_at: "2026-07-05T00:00:00.000Z",
  updated_at: "2026-07-05T00:00:00.000Z",
  completed_at: null,
};

describe("useTasks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the task list on mount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([SAMPLE_TASK]),
      }),
    );

    const { result } = renderHook(() => useTasks());

    await waitFor(() => expect(result.current.tasks).toEqual([SAMPLE_TASK]));
  });

  it("sets an error status when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useTasks());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.tasks).toEqual([]);
  });

  it("appends the created task after addTask resolves", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(SAMPLE_TASK),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addTask({ title: "資料を作る" });
    });

    expect(result.current.tasks).toEqual([SAMPLE_TASK]);
  });

  it("re-fetches the task list when refresh is called", async () => {
    const bossTask: Task = { ...SAMPLE_TASK, id: 2, title: "ボスが作ったタスク" };
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK, bossTask]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toEqual([SAMPLE_TASK]));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tasks).toEqual([SAMPLE_TASK, bossTask]);
  });

  it("ignores a stale response when refreshes overlap", async () => {
    const staleTask: Task = { ...SAMPLE_TASK, id: 1, title: "古い一覧" };
    const freshTask: Task = { ...SAMPLE_TASK, id: 2, title: "新しい一覧" };
    let resolveFirst: (value: unknown) => void = () => {};
    const fetchMock = vi.fn();
    // 1回目（マウント時）: 保留にして後から解決させる
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // 2回目（refresh）: 即座に解決
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([freshTask]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.tasks).toEqual([freshTask]));

    // 先行リクエストのレスポンスが後から到着しても、新しい結果を巻き戻さない
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: () => Promise.resolve([staleTask]),
      });
    });

    expect(result.current.tasks).toEqual([freshTask]);
  });

  it("sets an error status when refresh fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK]),
    });
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("error");
  });

  it("replaces the matching task after editTask resolves", async () => {
    const updated: Task = { ...SAMPLE_TASK, status: "in_progress" };
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toEqual([SAMPLE_TASK]));

    await act(async () => {
      await result.current.editTask(1, { status: "in_progress" });
    });

    expect(result.current.tasks).toEqual([updated]);
  });
});
