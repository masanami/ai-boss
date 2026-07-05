import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TaskBoard from "./TaskBoard";
import type { Task } from "./task";

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

describe("TaskBoard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distributes tasks into their status columns", async () => {
    const tasks = [
      makeTask({ id: 1, title: "todoのタスク", status: "todo" }),
      makeTask({ id: 2, title: "進行中のタスク", status: "in_progress" }),
      makeTask({ id: 3, title: "完了したタスク", status: "done" }),
      makeTask({ id: 4, title: "中止したタスク", status: "dropped" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tasks),
      }),
    );

    render(<TaskBoard />);

    await waitFor(() =>
      expect(screen.getByText("todoのタスク")).toBeInTheDocument(),
    );

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

  it("shows the boss comment on a task card", async () => {
    const tasks = [
      makeTask({ id: 1, boss_comment: "早めに着手しろ" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tasks),
      }),
    );

    render(<TaskBoard />);

    await waitFor(() =>
      expect(
        screen.getByText("ボスコメント: 早めに着手しろ"),
      ).toBeInTheDocument(),
    );
  });

  it("adds a newly created task to the todo column", async () => {
    const createdTask = makeTask({
      id: 5,
      title: "新しいタスク",
      status: "todo",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(createdTask),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TaskBoard />);

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "未着手" }),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "新しいタスク" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => {
      const todoColumn = screen.getByRole("region", { name: "未着手" });
      expect(within(todoColumn).getByText("新しいタスク")).toBeInTheDocument();
    });
  });

  it("shows an alert when creating a task fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "title is required" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TaskBoard />);

    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "未着手" }),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "失敗するタスク" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("title is required"),
    );
  });

  it("moves a task to the new column when its status is changed", async () => {
    const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
    const updatedTask = { ...task, status: "in_progress" as const };
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([task]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(updatedTask),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TaskBoard />);

    await waitFor(() =>
      expect(screen.getByText("todoのタスク")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("ステータス"), {
      target: { value: "in_progress" },
    });

    await waitFor(() => {
      const inProgressColumn = screen.getByRole("region", { name: "進行中" });
      expect(
        within(inProgressColumn).getByText("todoのタスク"),
      ).toBeInTheDocument();
    });

    const todoColumn = screen.getByRole("region", { name: "未着手" });
    expect(within(todoColumn).queryByText("todoのタスク")).not.toBeInTheDocument();
  });
});
