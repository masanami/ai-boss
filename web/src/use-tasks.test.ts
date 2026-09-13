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
  evidence_required: false,
  committed_start_at: null,
  committed_at: null,
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

  // Issue #526（#519 決定7）のAC「タスクボードでステータスを todo 以外へ変え、
  // 更新の応答の committed_start_at が null のとき…」の実体。send した patch
  // には committed_start_at を含めない（ステータス変更のみ）ため、応答ではなく
  // 送った patch を手元のタスクへマージする実装だと、退役前の約束が残って
  // しまう。変異: `{ ...task, ...patch }` でマージし応答を使わない — 入力
  // 「約束 2026-09-14T20:00:00.000Z を持つ todo のタスクへ { status:
  // "in_progress" } を送り、応答の committed_start_at は null」で
  // committed_start_at が古い値のまま残る。
  it("uses the response's committed_start_at, not a local merge of the sent patch, after editTask resolves (#526)", async () => {
    const committed: Task = {
      ...SAMPLE_TASK,
      committed_start_at: new Date(2026, 8, 14, 20, 0).toISOString(),
    };
    const updated: Task = {
      ...committed,
      status: "in_progress",
      committed_start_at: null,
    };
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([committed]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updated),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toEqual([committed]));

    await act(async () => {
      await result.current.editTask(1, { status: "in_progress" });
    });

    expect(result.current.tasks).toEqual([updated]);
    expect(result.current.tasks[0].committed_start_at).toBeNull();
  });

  // AC-72（機能仕様 決定 2-f）の実体はここにある: editTask は楽観更新をせず、
  // patchTask が解決してから state を更新する。したがって完了ゲートの 409 で
  // reject されたとき、タスクの status は変わらない＝タスクボードのカードは
  // 元の列に残る。TaskBoard 側でこれを確かめようとしても、カラムの所属は
  // 注入された tasks から導出されるだけなので恒真のアサーションになり、
  // 楽観更新を足す変異を検出できない（実測で確認）。担保はこの層に置く。
  it("leaves the task unchanged when editTask rejects (no optimistic update)", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_TASK]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          error: "evidence required",
          code: "evidence_required",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toEqual([SAMPLE_TASK]));

    await act(async () => {
      await expect(
        result.current.editTask(1, { status: "done" }),
      ).rejects.toThrow();
    });

    expect(result.current.tasks).toEqual([SAMPLE_TASK]);
    expect(result.current.tasks[0].status).toBe(SAMPLE_TASK.status);
  });
});
