import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
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

  it("lists today's pending tasks by default and keeps completed ones in a collapsed section (#245)", () => {
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
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("□ 資料を作る");
    expect(
      within(section).queryByText(/メールを返す/),
    ).not.toBeInTheDocument();

    const toggle = within(section).getByRole("button", {
      name: "完了したタスク（1 件）",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to show completed tasks with a filled marker in original order, and collapses again on a second click", () => {
    const tasks = [
      makeTask({ id: 1, title: "資料を作る", status: "todo" }),
      makeTask({
        id: 2,
        title: "メールを返す",
        status: "done",
        completed_at: new Date(2026, 6, 27, 9).toISOString(),
      }),
      makeTask({
        id: 3,
        title: "議事録を送る",
        status: "done",
        completed_at: new Date(2026, 6, 27, 10).toISOString(),
      }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    const toggle = within(section).getByRole("button", {
      name: "完了したタスク（2 件）",
    });

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const expandedItems = within(section).getAllByRole("listitem");
    expect(expandedItems).toHaveLength(3);
    expect(expandedItems[1]).toHaveTextContent("■ メールを返す");
    expect(expandedItems[2]).toHaveTextContent("■ 議事録を送る");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(section).queryByText(/メールを返す/),
    ).not.toBeInTheDocument();
  });

  it("keeps the default pending list in selectTodayTasks's original order (AC-2)", () => {
    // 並びは selectTodayTasks の戻り順（サーバの created_at ASC, id ASC）に従う。
    // 表示層が独自に並び替えていないことを見るため、status でも id でも title でも
    // ソートすると崩れる並びを意図的に組む（同じ status を離して置き、id を降順に
    // 混ぜる）。
    const tasks = [
      makeTask({ id: 3, title: "資料を作る", status: "todo" }),
      makeTask({ id: 1, title: "見積もりを送る", status: "paused" }),
      makeTask({ id: 2, title: "会議室を予約する", status: "todo" }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("□ 資料を作る");
    expect(items[1]).toHaveTextContent("□ 見積もりを送る");
    expect(items[2]).toHaveTextContent("□ 会議室を予約する");
  });

  it("does not leak a task completed on a past day into the collapsed section", () => {
    const tasks = [
      makeTask({ id: 1, title: "資料を作る", status: "todo" }),
      makeTask({
        id: 2,
        title: "メールを返す",
        status: "done",
        completed_at: new Date(2026, 6, 27, 9).toISOString(),
      }),
      makeTask({
        id: 3,
        title: "昨日の議事録を送る",
        status: "done",
        completed_at: new Date(2026, 6, 26, 11).toISOString(),
      }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    const toggle = within(section).getByRole("button", {
      name: "完了したタスク（1 件）",
    });

    fireEvent.click(toggle);

    expect(
      within(section).queryByText(/昨日の議事録を送る/),
    ).not.toBeInTheDocument();
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows no collapse header when there are no completed tasks today", () => {
    const tasks = [makeTask({ id: 1, title: "資料を作る", status: "todo" })];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    expect(
      within(section).queryByRole("button", { name: /完了したタスク/ }),
    ).not.toBeInTheDocument();
  });

  it("resets the expanded state after remounting (not persisted)", () => {
    const tasks = [
      makeTask({ id: 1, title: "資料を作る", status: "todo" }),
      makeTask({
        id: 2,
        title: "メールを返す",
        status: "done",
        completed_at: new Date(2026, 6, 27, 9).toISOString(),
      }),
    ];

    const { unmount } = render(<TodaySummary tasks={tasks} status="ready" />);
    let section = screen.getByRole("region", { name: "今日のタスク" });
    let toggle = within(section).getByRole("button", {
      name: "完了したタスク（1 件）",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    unmount();

    render(<TodaySummary tasks={tasks} status="ready" />);
    section = screen.getByRole("region", { name: "今日のタスク" });
    toggle = within(section).getByRole("button", {
      name: "完了したタスク（1 件）",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it('shows "今日のタスクはすべて完了しました" when all of today\'s tasks are completed', () => {
    const tasks = [
      makeTask({
        id: 1,
        title: "メールを返す",
        status: "done",
        completed_at: new Date(2026, 6, 27, 9).toISOString(),
      }),
    ];

    render(<TodaySummary tasks={tasks} status="ready" />);

    const section = screen.getByRole("region", { name: "今日のタスク" });
    expect(
      within(section).getByText("今日のタスクはすべて完了しました"),
    ).toBeInTheDocument();
    expect(
      within(section).queryByText("今日のタスクはまだありません"),
    ).not.toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "完了したタスク（1 件）" }),
    ).toBeInTheDocument();
  });

  it("shows neither the empty message nor the all-completed message when a pending task remains", () => {
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
    expect(
      within(section).queryByText("今日のタスクはまだありません"),
    ).not.toBeInTheDocument();
    expect(
      within(section).queryByText("今日のタスクはすべて完了しました"),
    ).not.toBeInTheDocument();
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
