import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DecisionRecord } from "./decision";
import type { Task } from "./task";
import { useTaskStartMentoringPrompt } from "./use-task-start-mentoring-prompt";

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `task-${overrides.id}`,
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
    ...overrides,
  };
}

/** `GET /api/decisions` の応答を、呼ばれた順にテスト側から解決する。 */
function stubDecisionsQueue() {
  const pending: ((records: DecisionRecord[]) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((records) =>
            resolve(new Response(JSON.stringify(records), { status: 200 })),
          );
        }),
    ),
  );
  return {
    get callCount() {
      return pending.length;
    },
    resolve(index: number, records: DecisionRecord[]) {
      pending[index](records);
    },
  };
}

type Props = { tasks: Task[]; canPrompt: boolean };

function renderPrompt(initial: Props) {
  return renderHook(
    ({ tasks, canPrompt }: Props) => useTaskStartMentoringPrompt(tasks, canPrompt),
    { initialProps: initial },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Issue #573（PR #572 Codex 2 巡目 P2）: 可否が偽になる描画と判定の完了が
// 同じ描画にまとめられると、判定は古い可否（ref）で表示に進む。その促しは
// 画面に出ない（AppLayout は可否が偽なら描画しない）ので、表示したことに
// してはならない（FR-6・決定8）。
describe("useTaskStartMentoringPrompt: 可否が偽の描画と重なった判定 (#573)", () => {
  const todoA = makeTask({ id: 1, status: "todo", estimated_minutes: 30 });
  const startedA = { ...todoA, status: "in_progress" as const };
  const todoB = makeTask({ id: 2, status: "todo", estimated_minutes: 15 });
  const startedB = { ...todoB, status: "in_progress" as const };

  /**
   * 可否を偽にする再描画と、`index` 番目の取得の解決を同じ act に入れる。
   * 判定（`.then`）は描画より先に走るため、可否の ref はまだ真のまま。
   */
  async function disablePromptWhileResolving(
    rerender: (props: Props) => void,
    tasks: Task[],
    queue: ReturnType<typeof stubDecisionsQueue>,
    index: number,
  ): Promise<void> {
    await act(async () => {
      rerender({ tasks, canPrompt: false });
      queue.resolve(index, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("does not mark a task as prompted when its prompt was never rendered because prompting became unavailable", async () => {
    const queue = stubDecisionsQueue();
    const { result, rerender } = renderPrompt({ tasks: [todoA], canPrompt: true });

    rerender({ tasks: [startedA], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(1));
    await disablePromptWhileResolving(rerender, [startedA], queue, 0);
    expect(result.current.promptTask).toBeNull();

    // 会が終わって adhoc に戻り、同じタスクを再着手する
    rerender({ tasks: [todoA], canPrompt: true });
    rerender({ tasks: [startedA], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(2));
    await act(async () => {
      queue.resolve(1, []);
    });

    await waitFor(() => expect(result.current.promptTask?.id).toBe(1));
  });

  it("does not advance the last shown number for a prompt that was never rendered (決定8)", async () => {
    const queue = stubDecisionsQueue();
    const { result, rerender } = renderPrompt({
      tasks: [todoA, todoB],
      canPrompt: true,
    });

    // 先に A（番号 1）、続いて B（番号 2）が着手される
    rerender({ tasks: [startedA, todoB], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(1));
    rerender({ tasks: [startedA, startedB], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(2));

    // B の判定は、可否が偽になる描画と重なり表示されない
    await disablePromptWhileResolving(rerender, [startedA, startedB], queue, 1);
    expect(result.current.promptTask).toBeNull();

    // 可否が戻ってから A の判定が「未確認」で完了する。表示された促しは
    // まだ無いので、A は表示される
    rerender({ tasks: [startedA, startedB], canPrompt: true });
    await act(async () => {
      queue.resolve(0, []);
    });

    await waitFor(() => expect(result.current.promptTask?.id).toBe(1));
  });

  // 番号の確定を描画後へ寄せても、描画前に続けて完了した判定のうち番号の
  // 最も新しい 1 件を描画する（決定8）。完了順が遷移順と逆でも変わらない。
  it("renders the newest transition's prompt when judgments complete before rendering in reverse order (決定8)", async () => {
    const queue = stubDecisionsQueue();
    const { result, rerender } = renderPrompt({
      tasks: [todoA, todoB],
      canPrompt: true,
    });

    rerender({ tasks: [startedA, todoB], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(1));
    rerender({ tasks: [startedA, startedB], canPrompt: true });
    await waitFor(() => expect(queue.callCount).toBe(2));

    // 同じ act の中で B（番号 2）→ A（番号 1）の順に判定が完了する
    await act(async () => {
      queue.resolve(1, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
      queue.resolve(0, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.promptTask?.id).toBe(2);
  });
});
