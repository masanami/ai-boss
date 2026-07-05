import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TaskCard from "./TaskCard";
import type { Task } from "./task";

const BASE_TASK: Task = {
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

describe("TaskCard", () => {
  it("renders the task title", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(
      screen.getByRole("heading", { name: "資料を作る" }),
    ).toBeInTheDocument();
  });

  it("shows the priority as a boss decision in Japanese", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, priority: "high" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("ボス決定: 優先度 高")).toBeInTheDocument();
  });

  it("hides the priority line when priority is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボス決定: 優先度/)).not.toBeInTheDocument();
  });

  it("shows the due date as a boss decision", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, due_at: "2026-07-10" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("ボス決定: 締切 2026-07-10"),
    ).toBeInTheDocument();
  });

  it("hides the due date line when due_at is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボス決定: 締切/)).not.toBeInTheDocument();
  });

  it("shows the boss comment when present", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, boss_comment: "早めに着手しろ" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("ボスコメント: 早めに着手しろ"),
    ).toBeInTheDocument();
  });

  it("hides the boss comment line when boss_comment is null", () => {
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={vi.fn()} />,
    );

    expect(screen.queryByText(/ボスコメント/)).not.toBeInTheDocument();
  });

  it("calls onStatusChange with the new status when the status select changes", () => {
    const onStatusChange = vi.fn();
    render(
      <TaskCard
        task={BASE_TASK}
        onStatusChange={onStatusChange}
        onEdit={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("ステータス"), {
      target: { value: "in_progress" },
    });

    expect(onStatusChange).toHaveBeenCalledWith(1, "in_progress");
  });

  it("enters edit mode with fields pre-filled when the edit button is clicked", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, priority: "medium", due_at: "2026-07-10" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));

    expect(screen.getByLabelText("タイトル")).toHaveValue("資料を作る");
    expect(screen.getByLabelText("締切")).toHaveValue("2026-07-10");
  });

  it("calls onEdit with the updated fields when the edit form is submitted", () => {
    const onEdit = vi.fn();
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "資料を仕上げる" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(1, {
      title: "資料を仕上げる",
      description: null,
      priority: null,
      due_at: null,
    });
  });

  it("calls onEdit with all fields when they are edited to non-null values", () => {
    const onEdit = vi.fn();
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("説明"), {
      target: { value: "月次報告資料" },
    });
    fireEvent.change(screen.getByLabelText("優先度"), {
      target: { value: "low" },
    });
    fireEvent.change(screen.getByLabelText("締切"), {
      target: { value: "2026-07-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onEdit).toHaveBeenCalledWith(1, {
      title: "資料を作る",
      description: "月次報告資料",
      priority: "low",
      due_at: "2026-07-15",
    });
  });

  it("normalizes an ISO datetime due_at to its date part for display and editing", () => {
    render(
      <TaskCard
        task={{ ...BASE_TASK, due_at: "2026-07-10T09:00:00.000Z" }}
        onStatusChange={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    expect(screen.getByText("ボス決定: 締切 2026-07-10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByLabelText("締切")).toHaveValue("2026-07-10");
  });

  it("discards edits and returns to view mode when cancel is clicked", () => {
    const onEdit = vi.fn();
    render(
      <TaskCard task={BASE_TASK} onStatusChange={vi.fn()} onEdit={onEdit} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "変更中のタイトル" },
    });
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "資料を作る" }),
    ).toBeInTheDocument();
  });
});
