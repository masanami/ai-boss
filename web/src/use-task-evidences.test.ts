import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTaskEvidences } from "./use-task-evidences";
import type { TaskEvidence } from "./task-evidence";

function makeEvidence(
  overrides: Partial<TaskEvidence> & { id: number; kind: "file" | "link" },
): TaskEvidence {
  return {
    task_id: 1,
    stored_filename: null,
    original_filename: null,
    mime_type: null,
    size_bytes: null,
    url: null,
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function isGet(call: unknown[]): boolean {
  return (call[1] as RequestInit | undefined) === undefined;
}

function isPost(call: unknown[]): boolean {
  return (call[1] as RequestInit | undefined)?.method === "POST";
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTaskEvidences", () => {
  it("does not fetch while disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useTaskEvidences(1, false));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // #6: 連打で同じ追加が 2 回飛ぶのを防ぐ（`use-checkin-panel` の submittingRef と
  // 同じ規律）。UI 側の disabled とは別に、フック自身が弾けることを確かめる
  // （disabled は再レンダリング後にしか効かないため、両方が要る）。
  it("ignores a second mutation while the first is still in flight", async () => {
    const created = makeEvidence({
      id: 41,
      kind: "link",
      url: "https://example.com/once",
    });
    let resolvePost: (value: unknown) => void = () => {};
    const pendingPost = new Promise((resolve) => {
      resolvePost = resolve;
    });
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return pendingPost;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTaskEvidences(1, true));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // 1 回目を await せずに 2・3 回目を呼ぶ（再レンダリングを挟まない連打）
    await act(async () => {
      const first = result.current.addLink("https://example.com/once");
      const second = result.current.addLink("https://example.com/once");
      const third = result.current.addLink("https://example.com/once");
      resolvePost({
        ok: true,
        status: 201,
        json: () => Promise.resolve(created),
      });
      const results = await Promise.all([first, second, third]);
      // 弾かれた呼び出しは false を返す
      expect(results).toEqual([true, false, false]);
    });

    expect(fetchMock.mock.calls.filter(isPost)).toHaveLength(1);
  });

  // #3 経路 B: 初回 GET の応答が届く前に追加が成功した場合、あとから届いた古い
  // 一覧が追加分を上書きして消してはならない（世代番号で無効化する）。
  // ここで一覧そのもの（evidences）を見るのは、描画ゲート（status === "ready"）
  // を経由すると経路 A の修正（追加成功後の再取得）にも依存してしまい、
  // 2 つの経路を独立に検出できなくなるため。
  it("does not let a stale in-flight list fetch overwrite a newly added evidence", async () => {
    const created = makeEvidence({
      id: 31,
      kind: "link",
      url: "https://example.com/raced",
    });
    let resolveStaleList: (value: unknown) => void = () => {};
    const staleList = new Promise((resolve) => {
      resolveStaleList = resolve;
    });
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(created),
        });
      }
      // 1 回目の GET だけ保留にする（＝追加より遅れて届く古い一覧）
      if (fetchMock.mock.calls.filter(isGet).length === 1) {
        return staleList;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([created]),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTaskEvidences(1, true));
    await waitFor(() => expect(result.current.status).toBe("loading"));

    await act(async () => {
      await result.current.addLink("https://example.com/raced");
    });
    expect(result.current.evidences).toEqual([created]);

    // ここで初回 GET が「追加分を含まない古い一覧」で解決する
    await act(async () => {
      resolveStaleList({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
      await staleList;
    });

    // 追加分は消えない
    expect(result.current.evidences).toEqual([created]);
  });

  it("reports failures with the UI-owned message for a known code", async () => {
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            Promise.resolve({
              error: "task already has the maximum of 10 evidences",
              code: "evidence_limit_exceeded",
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTaskEvidences(1, true));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addLink("https://example.com/over-limit");
    });

    expect(result.current.actionError).toBe(
      "エビデンスは 1 つのタスクにつき 10 件までです。不要なものを削除してください",
    );
    // 追加は失敗したので一覧は取り直されない（GET は初回の 1 回だけ）
    expect(fetchMock.mock.calls.filter(isGet)).toHaveLength(1);
  });
});
