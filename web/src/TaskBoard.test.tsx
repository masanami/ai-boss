import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TaskBoard from "./TaskBoard";
import type { Task } from "./task";
import type { UseTasksResult } from "./use-tasks";

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

  it("refreshes the shared task list on mount", () => {
    const tasksState = makeTasksState();

    render(<TaskBoard tasksState={tasksState} />);

    // タブ切替（再マウント）のたびに再取得していた従来挙動の維持。
    // チャットでボスが tool use で作成・更新したタスクをボード表示時に拾う。
    expect(tasksState.refresh).toHaveBeenCalledTimes(1);
  });
});
