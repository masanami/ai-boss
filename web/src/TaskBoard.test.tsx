import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TaskBoard from "./TaskBoard";
import type { Task } from "./task";
import type { UseTasksResult } from "./use-tasks";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";
import { EVIDENCE_REQUIRED_DISPLAY_MESSAGE, TasksApiError } from "./tasks-api";

// jsdom は DataTransfer を実装しないため、setData/getData を持つ簡易スタブを
// 自前で用意する（Issue #122）。ドラッグ開始 → ドロップの一連の流れを模すため
// 同一インスタンスを dragStart/dragOver/drop へ使い回す。
function makeDataTransfer(initialTaskId?: number) {
  const store = new Map<string, string>();
  if (initialTaskId !== undefined) {
    store.set(TASK_DRAG_DATA_TYPE, String(initialTaskId));
  }
  return {
    setData: vi.fn((type: string, value: string) => {
      store.set(type, value);
    }),
    getData: vi.fn((type: string) => store.get(type) ?? ""),
    dropEffect: "",
    effectAllowed: "",
  };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
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
    ...overrides,
  };
}

/**
 * 「完了」「中止」列の直近ウィンドウ（#428）を検証するための固定時刻。
 * ローカル 2026-09-10 12:00。この now での包含範囲は 2026-09-04〜2026-09-10。
 * UTC 文字列リテラルではなくローカル暦日から組む（ADR 0007 決定 5）。
 */
const NOW = new Date(2026, 8, 10, 12, 0, 0);

/** ローカル暦日から ISO 文字列を組む（サーバが返す形に合わせる）。 */
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): string {
  return new Date(
    year,
    monthIndex,
    day,
    hour,
    minute,
    second,
    millisecond,
  ).toISOString();
}

// tasks 状態は AppLayout にリフトアップされたので、TaskBoard には
// UseTasksResult 相当を props で渡す（Issue #70）。
function makeTasksState(overrides: Partial<UseTasksResult> = {}): UseTasksResult {
  return {
    tasks: [],
    status: "ready",
    addTask: vi.fn().mockResolvedValue(undefined),
    editTask: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("TaskBoard", () => {
  // 直近ウィンドウのテストだけが Date を固定する。実タイマーのままの
  // テストでは no-op なので、既存テストの挙動は変わらない。
  afterEach(() => {
    vi.useRealTimers();
  });

  it("distributes tasks into their status columns, with 完了/中止 limited to the recent window (#428)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);

    // done / dropped は範囲内の基準時刻を持たないと列に出ない（#428）。
    const tasks = [
      makeTask({ id: 1, title: "todoのタスク", status: "todo" }),
      makeTask({ id: 2, title: "進行中のタスク", status: "in_progress" }),
      makeTask({
        id: 3,
        title: "完了したタスク",
        status: "done",
        completed_at: localIso(2026, 8, 10, 9),
      }),
      makeTask({
        id: 4,
        title: "中止したタスク",
        status: "dropped",
        updated_at: localIso(2026, 8, 10, 9),
      }),
    ];

    render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

    const todoColumn = screen.getByRole("region", { name: "未着手" });
    expect(within(todoColumn).getByText("todoのタスク")).toBeInTheDocument();

    const inProgressColumn = screen.getByRole("region", { name: "進行中" });
    expect(
      within(inProgressColumn).getByText("進行中のタスク"),
    ).toBeInTheDocument();

    const doneColumn = screen.getByRole("region", { name: "完了" });
    expect(within(doneColumn).getByText("完了したタスク")).toBeInTheDocument();

    const droppedColumn = screen.getByRole("region", { name: "中止" });
    expect(
      within(droppedColumn).getByText("中止したタスク"),
    ).toBeInTheDocument();
  });

  it("distributes a paused task into the 一時停止 column, next to 進行中 (AC-12, G-179-12)", () => {
    const tasks = [
      makeTask({ id: 1, title: "一時停止したタスク", status: "paused" }),
    ];

    render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

    const pausedColumn = screen.getByRole("region", { name: "一時停止" });
    expect(
      within(pausedColumn).getByText("一時停止したタスク"),
    ).toBeInTheDocument();

    // カラムの並び順（進行中の隣・5カラム構成）を検証する。
    const columnLabels = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(columnLabels).toEqual([
      "未着手",
      "進行中",
      "一時停止",
      "完了",
      "中止",
    ]);
  });

  it("shows the boss comment on a task card", () => {
    const tasks = [makeTask({ id: 1, boss_comment: "早めに着手しろ" })];

    render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

    expect(
      screen.getByText("ボスコメント: 早めに着手しろ"),
    ).toBeInTheDocument();
  });

  it("shows an alert when the task list failed to load", () => {
    render(<TaskBoard tasksState={makeTasksState({ status: "error" })} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "タスクの取得に失敗しました",
    );
  });

  it("calls addTask with the form input when a task is created", async () => {
    const tasksState = makeTasksState();

    render(<TaskBoard tasksState={tasksState} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "新しいタスク" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(tasksState.addTask).toHaveBeenCalledWith(
        expect.objectContaining({ title: "新しいタスク" }),
      ),
    );
  });

  it("shows an alert when creating a task fails", async () => {
    const tasksState = makeTasksState({
      addTask: vi.fn().mockRejectedValue(new Error("title is required")),
    });

    render(<TaskBoard tasksState={tasksState} />);

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "失敗するタスク" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("title is required"),
    );
  });

  it("calls editTask when a task's status is changed", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    fireEvent.change(screen.getByLabelText("ステータス"), {
      target: { value: "in_progress" },
    });

    await waitFor(() =>
      expect(tasksState.editTask).toHaveBeenCalledWith(1, {
        status: "in_progress",
      }),
    );
  });

  it("calls editTask with the drop column's status when a card is dropped there", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(1);
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragOver(inProgressColumn, { dataTransfer });
    fireEvent.drop(inProgressColumn, { dataTransfer });

    await waitFor(() =>
      expect(tasksState.editTask).toHaveBeenCalledWith(1, {
        status: "in_progress",
      }),
    );
  });

  it("does not call editTask when a card is dropped into its own column", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(1);
    const todoColumn = screen.getByRole("region", { name: "未着手" });

    fireEvent.dragOver(todoColumn, { dataTransfer });
    fireEvent.drop(todoColumn, { dataTransfer });

    expect(tasksState.editTask).not.toHaveBeenCalled();
  });

  it("does nothing when the dropped dataTransfer has no valid task id", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(); // id 未設定
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    expect(() => {
      fireEvent.dragOver(inProgressColumn, { dataTransfer });
      fireEvent.drop(inProgressColumn, { dataTransfer });
    }).not.toThrow();
    expect(tasksState.editTask).not.toHaveBeenCalled();
  });

  it("keeps the card in its original column and shows an alert when the drop update fails", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({
      tasks: [task],
      editTask: vi.fn().mockRejectedValue(new Error("更新に失敗しました")),
    });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(1);
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragOver(inProgressColumn, { dataTransfer });
    fireEvent.drop(inProgressColumn, { dataTransfer });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("更新に失敗しました"),
    );
    // 楽観的更新をしないため tasks は変わらず、カードは元の todo カラムに残る
    const todoColumn = screen.getByRole("region", { name: "未着手" });
    expect(within(todoColumn).getByText("todoのタスク")).toBeInTheDocument();
  });

  it("keeps the card in its original column and shows the fixed evidence-required message when the evidence gate blocks the drop (AC-72/73)", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({
      tasks: [task],
      editTask: vi
        .fn()
        .mockRejectedValue(
          new TasksApiError("サーバの文言A", "evidence_required"),
        ),
    });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(1);
    const doneColumn = screen.getByRole("region", { name: "完了" });

    fireEvent.dragOver(doneColumn, { dataTransfer });
    fireEvent.drop(doneColumn, { dataTransfer });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        EVIDENCE_REQUIRED_DISPLAY_MESSAGE,
      ),
    );
    const todoColumn = screen.getByRole("region", { name: "未着手" });
    expect(within(todoColumn).getByText("todoのタスク")).toBeInTheDocument();
  });

  it("shows the same fixed message regardless of the server's wording, proving the branch is code-based (AC-76)", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({
      tasks: [task],
      editTask: vi
        .fn()
        .mockRejectedValue(
          new TasksApiError("まったく違う文言B", "evidence_required"),
        ),
    });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer(1);
    const doneColumn = screen.getByRole("region", { name: "完了" });

    fireEvent.dragOver(doneColumn, { dataTransfer });
    fireEvent.drop(doneColumn, { dataTransfer });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        EVIDENCE_REQUIRED_DISPLAY_MESSAGE,
      ),
    );
  });

  it("highlights the target column while dragging a card over a different column", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragStart(card as Element, { dataTransfer });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).toHaveClass("task-column-drag-over");
  });

  // ハイライトは drop が実際に更新する組み合わせだけに出す。光ったのに何も
  // 起きない状態を作らない（PR #125 レビュー指摘）。
  it("does not highlight the column the dragged card already belongs to", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    const todoColumn = screen.getByRole("region", { name: "未着手" });

    fireEvent.dragStart(card as Element, { dataTransfer });
    fireEvent.dragEnter(todoColumn, { dataTransfer });

    expect(todoColumn).not.toHaveClass("task-column-drag-over");
  });

  it("does not highlight any column for a drag that did not start from a card (external drag)", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    // dragStart を経ていない＝アプリ外（ファイル等）からのドラッグ。
    const dataTransfer = makeDataTransfer(1);
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragEnter(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).not.toHaveClass("task-column-drag-over");
  });

  it("does not highlight when the dragged card is no longer in the task list", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    const { rerender } = render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    fireEvent.dragStart(card as Element, { dataTransfer });

    // ドラッグ中に refresh 等でタスクが消えた場合（未知の id と同じ扱い）。
    rerender(<TaskBoard tasksState={makeTasksState({ tasks: [] })} />);

    const inProgressColumn = screen.getByRole("region", { name: "進行中" });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).not.toHaveClass("task-column-drag-over");
  });

  it("clears the drag highlight when the drag ends without a drop (dragend)", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragStart(card as Element, { dataTransfer });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });
    expect(inProgressColumn).toHaveClass("task-column-drag-over");

    // dragend 後は新たな dragEnter でもハイライトしない（状態が解除済み）。
    fireEvent.dragEnd(card as Element, { dataTransfer });
    fireEvent.dragLeave(inProgressColumn, { dataTransfer });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).not.toHaveClass("task-column-drag-over");
  });

  it("clears the drag highlight on dragleave without a drop", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragStart(card as Element, { dataTransfer });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });
    expect(inProgressColumn).toHaveClass("task-column-drag-over");

    fireEvent.dragLeave(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).not.toHaveClass("task-column-drag-over");
  });

  it("clears the drag highlight after a drop", () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const tasksState = makeTasksState({ tasks: [task] });

    render(<TaskBoard tasksState={tasksState} />);

    const dataTransfer = makeDataTransfer();
    const card = screen.getByText("todoのタスク").closest(".task-card");
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });

    fireEvent.dragStart(card as Element, { dataTransfer });
    fireEvent.dragEnter(inProgressColumn, { dataTransfer });
    expect(inProgressColumn).toHaveClass("task-column-drag-over");

    fireEvent.dragOver(inProgressColumn, { dataTransfer });
    fireEvent.drop(inProgressColumn, { dataTransfer });

    expect(inProgressColumn).not.toHaveClass("task-column-drag-over");
  });

  it("refreshes the shared task list on mount", () => {
    const tasksState = makeTasksState();

    render(<TaskBoard tasksState={tasksState} />);

    // タブ切替（再マウント）のたびに再取得していた従来挙動の維持。
    // チャットでボスが tool use で作成・更新したタスクをボード表示時に拾う。
    expect(tasksState.refresh).toHaveBeenCalledTimes(1);
  });

  // Issue #470 (親 #444): TaskBoard は onStartMentoring をそのまま
  // TaskCard へ渡すだけで、判断には関与しない。
  describe("onStartMentoring passthrough (Issue #470)", () => {
    it("passes onStartMentoring through to the task card and calls it with the clicked task id", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });
      const onStartMentoring = vi.fn();

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks: [task] })}
          onStartMentoring={onStartMentoring}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "メンタリングする" }),
      );

      expect(onStartMentoring).toHaveBeenCalledWith(7);
    });

    it("does not render the mentoring button when onStartMentoring is not provided", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });

      render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });

    it("does not render the mentoring button when onStartMentoring is null (meeting in progress)", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks: [task] })}
          onStartMentoring={null}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });
  });

  // 「完了」「中止」列をローカル暦日で直近 7 日に絞る（Issue #428 / #437）。
  // now = 2026-09-10 のとき包含範囲は 2026-09-04〜2026-09-10。
  describe("完了/中止 列の直近ウィンドウ (#428)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("does not show 完了/中止 tasks whose reference falls on the day before the lower bound (AC-1, AC-3)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "境界の1日前に完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 3, 23, 59, 59),
        }),
        makeTask({
          id: 2,
          title: "境界の1日前に中止したタスク",
          status: "dropped",
          updated_at: localIso(2026, 8, 3, 23, 59, 59),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      expect(
        screen.queryByText("境界の1日前に完了したタスク"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("境界の1日前に中止したタスク"),
      ).not.toBeInTheDocument();
    });

    it("does not show a 完了 task completed well before the window (AC-2)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "先月完了したタスク",
          status: "done",
          completed_at: localIso(2026, 7, 1, 10),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      expect(screen.queryByText("先月完了したタスク")).not.toBeInTheDocument();
    });

    it("does not show a done task whose completed_at is null (AC-4)", () => {
      // 決定 4: 基準時刻が取れないものは範囲外へ倒す（fail-open にしない）。
      const tasks = [
        makeTask({
          id: 1,
          title: "完了時刻が無いタスク",
          status: "done",
          completed_at: null,
          updated_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      expect(screen.queryByText("完了時刻が無いタスク")).not.toBeInTheDocument();
    });

    it("does not use updated_at for the 完了 column (AC-5)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "古く完了して今日触ったタスク",
          status: "done",
          completed_at: localIso(2026, 8, 2, 10),
          updated_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      expect(
        screen.queryByText("古く完了して今日触ったタスク"),
      ).not.toBeInTheDocument();
    });

    it("shows a 完了 task completed today (AC-6)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "今日完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(
        within(doneColumn).getByText("今日完了したタスク"),
      ).toBeInTheDocument();
    });

    it("shows 完了/中止 tasks at the first moment of the lower-bound calendar day (AC-7, AC-8)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "下限ちょうどに完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 4, 0, 0, 0, 0),
        }),
        makeTask({
          id: 2,
          title: "下限ちょうどに中止したタスク",
          status: "dropped",
          updated_at: localIso(2026, 8, 4, 0, 0, 0, 0),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(
        within(doneColumn).getByText("下限ちょうどに完了したタスク"),
      ).toBeInTheDocument();

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByText("下限ちょうどに中止したタスク"),
      ).toBeInTheDocument();
    });

    it("shows a 中止 task updated today (AC-9)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "今日中止したタスク",
          status: "dropped",
          updated_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByText("今日中止したタスク"),
      ).toBeInTheDocument();
    });

    it("does not use completed_at for the 中止 column (AC-10)", () => {
      // dropped の completed_at は updateTask が null にするため、これを基準に
      // すると中止列は常に空になる（決定 3）。
      const tasks = [
        makeTask({
          id: 1,
          title: "完了時刻が古い中止タスク",
          status: "dropped",
          completed_at: localIso(2026, 8, 1, 10),
          updated_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByText("完了時刻が古い中止タスク"),
      ).toBeInTheDocument();
    });

    it("brings a stale 中止 task back once its updated_at moves into the window (AC-11)", () => {
      // updated_at を基準に採った帰結であり、バグではない（決定 3 の
      // 「意図した振る舞い」）。
      const stale = makeTask({
        id: 1,
        title: "古い中止タスク",
        status: "dropped",
        updated_at: localIso(2026, 8, 1, 10),
      });

      const { rerender } = render(
        <TaskBoard tasksState={makeTasksState({ tasks: [stale] })} />,
      );
      expect(screen.queryByText("古い中止タスク")).not.toBeInTheDocument();

      rerender(
        <TaskBoard
          tasksState={makeTasksState({
            tasks: [{ ...stale, updated_at: localIso(2026, 8, 10, 9) }],
          })}
        />,
      );

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByText("古い中止タスク"),
      ).toBeInTheDocument();
    });

    it("keeps 未着手/進行中/一時停止 tasks visible regardless of their timestamps (AC-12)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "古い未着手タスク",
          status: "todo",
          updated_at: localIso(2026, 0, 1, 10),
        }),
        makeTask({
          id: 2,
          title: "古い進行中タスク",
          status: "in_progress",
          updated_at: localIso(2026, 0, 1, 10),
        }),
        makeTask({
          id: 3,
          title: "古い一時停止タスク",
          status: "paused",
          updated_at: localIso(2026, 0, 1, 10),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      expect(
        within(screen.getByRole("region", { name: "未着手" })).getByText(
          "古い未着手タスク",
        ),
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole("region", { name: "進行中" })).getByText(
          "古い進行中タスク",
        ),
      ).toBeInTheDocument();
      expect(
        within(screen.getByRole("region", { name: "一時停止" })).getByText(
          "古い一時停止タスク",
        ),
      ).toBeInTheDocument();
    });

    it("shows a card in the 完了 column right after it is dropped there (AC-13)", async () => {
      const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
      const tasksState = makeTasksState({ tasks: [task] });

      const { rerender } = render(<TaskBoard tasksState={tasksState} />);

      const dataTransfer = makeDataTransfer(1);
      const doneColumn = screen.getByRole("region", { name: "完了" });
      fireEvent.dragOver(doneColumn, { dataTransfer });
      fireEvent.drop(doneColumn, { dataTransfer });

      await waitFor(() =>
        expect(tasksState.editTask).toHaveBeenCalledWith(1, { status: "done" }),
      );

      // サーバ反映後の再取得結果で再描画する（完了時刻は当日になる）。
      rerender(
        <TaskBoard
          tasksState={makeTasksState({
            tasks: [
              {
                ...task,
                status: "done",
                completed_at: localIso(2026, 8, 10, 12),
                updated_at: localIso(2026, 8, 10, 12),
              },
            ],
          })}
        />,
      );

      expect(
        within(screen.getByRole("region", { name: "完了" })).getByText(
          "todoのタスク",
        ),
      ).toBeInTheDocument();
    });

    it("keeps the server's order for the tasks left in the 完了 column (AC-14)", () => {
      // サーバは created_at ASC, id ASC で返す。絞り込みは並びを変えない。
      const tasks = [
        makeTask({
          id: 1,
          title: "先に完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 5, 9),
        }),
        makeTask({
          id: 2,
          title: "範囲外で完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 1, 9),
        }),
        makeTask({
          id: 3,
          title: "後に完了したタスク",
          status: "done",
          completed_at: localIso(2026, 8, 9, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      const titles = within(doneColumn)
        .getAllByRole("listitem")
        .map(
          (item) => within(item).getByRole("heading", { level: 3 }).textContent,
        );
      expect(titles).toEqual(["先に完了したタスク", "後に完了したタスク"]);
    });

    it("renders only the in-window 完了 tasks (AC-15)", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "範囲内1",
          status: "done",
          completed_at: localIso(2026, 8, 10, 9),
        }),
        makeTask({
          id: 2,
          title: "範囲外1",
          status: "done",
          completed_at: localIso(2026, 8, 1, 9),
        }),
        makeTask({
          id: 3,
          title: "範囲内2",
          status: "done",
          completed_at: localIso(2026, 8, 6, 9),
        }),
        makeTask({
          id: 4,
          title: "範囲外2",
          status: "done",
          completed_at: localIso(2026, 7, 20, 9),
        }),
        makeTask({
          id: 5,
          title: "範囲外3",
          status: "done",
          completed_at: null,
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(within(doneColumn).getAllByRole("listitem")).toHaveLength(2);
    });

    it("labels the 完了 heading with the window length (AC-16)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      // 定数を import せずリテラルで固定する（AC-38 の変異確認を成立させる）。
      // アンカー付きで完全一致にし、件数表示等の後付け（決定 6 の却下事項）が
      // 素通りしないようにする。
      expect(
        within(doneColumn).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(/^完了（直近 7 日）$/);
    });

    it("labels the 中止 heading with the window length (AC-17)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(/^中止（直近 7 日）$/);
    });

    it("leaves the headings of the non-terminal columns unchanged (AC-18)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      for (const label of ["未着手", "進行中", "一時停止"]) {
        const column = screen.getByRole("region", { name: label });
        expect(
          within(column).getByRole("heading", { level: 2 }),
        ).toHaveTextContent(new RegExp(`^${label}$`));
      }
    });

    it("leaves the column aria-labels unchanged (AC-19)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const columnLabels = screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label"));
      expect(columnLabels).toEqual([
        "未着手",
        "進行中",
        "一時停止",
        "完了",
        "中止",
      ]);
      // 完全一致で引けること（見出しの文言変更が波及していないこと）。
      expect(screen.getByRole("region", { name: "完了" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "中止" })).toBeInTheDocument();
    });
  });
});
