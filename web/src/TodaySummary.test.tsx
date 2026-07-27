import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import TodaySummary from "./TodaySummary";
import type { Task } from "./task";

// コンポーネント内部の「今日」判定を決定的にするため時刻を固定する。
// 値はローカル日付基準で組み立て、TZ に依存しない。
const NOW = new Date(2026, 6, 27, 12, 0, 0);

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
    created_at: new Date(2026, 6, 25, 9).toISOString(),
    updated_at: new Date(2026, 6, 25, 9).toISOString(),
    completed_at: null,
    ...overrides,
  };
}

describe("TodaySummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists today's tasks with a filled marker for done and an empty marker otherwise", () => {
    const tasks = [
      makeTask({ id: 1, title: "資料を作る", status: "todo" }),
      makeTask({
        id: 2,
        title: "メールを返す",
        status: "done",
        completed_at: new Date(2026, 6, 27, 9).toISOString(),
      }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("□ 資料を作る");
    expect(items[1]).toHaveTextContent("■ メールを返す");
  });

  it("shows a progress gauge and completion text for today's tasks", () => {
    const tasks = [
      makeTask({ id: 1, status: "todo" }),
      makeTask({ id: 2, status: "in_progress" }),
      makeTask({ id: 3, status: "in_progress" }),
      makeTask({ id: 4, status: "in_progress" }),
      makeTask({
        id: 5,
        status: "done",
        completed_at: new Date(2026, 6, 27, 10).toISOString(),
      }),
      makeTask({
        id: 6,
        status: "done",
        completed_at: new Date(2026, 6, 27, 11).toISOString(),
      }),
      // 過去日完了は進捗の分母・分子に入らない
      makeTask({
        id: 7,
        status: "done",
        completed_at: new Date(2026, 6, 26, 11).toISOString(),
      }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const gauge = screen.getByRole("progressbar", {
      name: "今日のノルマ進捗",
    });
    expect(gauge).toHaveAttribute("aria-valuenow", "33");
    expect(screen.getByText("2 / 6 件完了（33%）")).toBeInTheDocument();
  });

  it("shows an empty message and 0% progress when there are no tasks for today", () => {
    render(<TodaySummary tasks={[]} status="ready" />);

    expect(
      screen.getByText("今日のタスクはまだありません"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "今日のノルマ進捗" }),
    ).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0 / 0 件完了（0%）")).toBeInTheDocument();
  });

  it("shows a loading message while the task list is loading", () => {
    render(<TodaySummary tasks={[]} status="loading" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    expect(within(section).getByText("読み込み中…")).toBeInTheDocument();
    expect(
      within(section).queryByText("今日のタスクはまだありません"),
    ).not.toBeInTheDocument();
  });

  it("shows an error message when the task list failed to load", () => {
    render(<TodaySummary tasks={[]} status="error" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    expect(within(section).getByRole("alert")).toHaveTextContent(
      "タスクの取得に失敗しました",
    );
  });
});
