import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TaskBoard from "./TaskBoard";
import type { Task } from "./task";
import type { UseTasksResult } from "./use-tasks";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";

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
    ...overrides,
  };
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
  it("distributes tasks into their status columns", () => {
    const tasks = [
      makeTask({ id: 1, title: "todoのタスク", status: "todo" }),
      makeTask({ id: 2, title: "進行中のタスク", status: "in_progress" }),
      makeTask({ id: 3, title: "完了したタスク", status: "done" }),
      makeTask({ id: 4, title: "中止したタスク", status: "dropped" }),
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
});
