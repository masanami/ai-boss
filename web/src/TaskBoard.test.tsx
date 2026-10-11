import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TaskBoard from "./TaskBoard";
import type { DecisionRecord } from "./decision";
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
    committed_start_at: null,
    committed_at: null,
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

/**
 * 完了・中止列は既定で畳まれているため、カードを主張する既存アサーションの
 * 前提として展開する（#515 決定2）。畳んだままでは窓の絞り込みを外しても
 * 通る恒真テストになるため、除外側のアサーションでも必ず呼ぶ。展開が実際に
 * 起きたこと（aria-expanded="true"）もあわせて確認する。
 */
function expandTerminalColumn(label: "完了" | "中止") {
  const column = screen.getByRole("region", { name: label });
  // 日数・件数は見出しの完全一致テストが固定するので、ここでは問わない
  // （窓の日数を変えたときに、見出しと無関係なテストまで落ちないようにする）。
  const toggle = within(column).getByRole("button", {
    name: new RegExp(`^${label}（直近 \\d+ 日・\\d+ 件）$`),
  });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  return column;
}

describe("TaskBoard", () => {
  // TaskBoard はマウント時に GET /api/decisions を取得する（Issue #713 /
  // #561 S3 決定12）。既定は永久に解決しない fetch にして、印と無関係な
  // テストが取得完了後の setState（act 警告）を起こさないようにする。印の
  // テストは describe 内で応答を差し替える。
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  // 直近ウィンドウのテストだけが Date を固定する。実タイマーのままの
  // テストでは no-op なので、既存テストの挙動は変わらない。
  afterEach(() => {
    vi.unstubAllGlobals();
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

    const doneColumn = expandTerminalColumn("完了");
    expect(within(doneColumn).getByText("完了したタスク")).toBeInTheDocument();

    const droppedColumn = expandTerminalColumn("中止");
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

  // Issue #526 (#519 決定7・AC「タスクボードでステータスを todo 以外へ変え…」):
  // 更新の応答の committed_start_at が null なら、そのカードから約束の行が
  // 消える。TaskBoard は use-tasks の editTask（サーバ応答をそのままタスクに
  // 置き換える）を経由するため、画面側でパッチをローカルマージしてはならない
  // （変異は下記コメントのとおり）。
  it("clears the start commitment line from the card after a drop when the update response's committed_start_at is null (#526)", async () => {
    const committedTask = makeTask({
      id: 1,
      title: "約束を持つタスク",
      status: "todo",
      committed_start_at: new Date(2026, 8, 14, 20, 0).toISOString(),
    });
    const tasksState = makeTasksState({ tasks: [committedTask] });

    const { rerender } = render(<TaskBoard tasksState={tasksState} />);

    expect(
      screen.getByText("ボス決定: 着手の約束 2026-09-14 20:00"),
    ).toBeInTheDocument();

    const dataTransfer = makeDataTransfer(1);
    const inProgressColumn = screen.getByRole("region", { name: "進行中" });
    fireEvent.dragOver(inProgressColumn, { dataTransfer });
    fireEvent.drop(inProgressColumn, { dataTransfer });

    await waitFor(() =>
      expect(tasksState.editTask).toHaveBeenCalledWith(1, {
        status: "in_progress",
      }),
    );

    // サーバ応答（committed_start_at: null）で手元のタスクを置き換えた結果の
    // 再描画。このテストの tasksState はモックなので、「送ったパッチを手元の
    // タスクへマージし応答を使わない」変異（use-tasks.ts の editTask）は
    // ここでは検出できない。その変異は use-tasks.test.ts の
    // "uses the response's committed_start_at, ..." が検出する。ここが担保する
    // のは「応答の committed_start_at が null なら画面から行が消える」表示側。
    rerender(
      <TaskBoard
        tasksState={makeTasksState({
          tasks: [
            {
              ...committedTask,
              status: "in_progress",
              committed_start_at: null,
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByText(/ボス決定: 着手の約束/),
    ).not.toBeInTheDocument();
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
    // Issue #489 (S1a・決定9): 中継する引数は id ではなくクリックされた
    // カードのタスクそのもの。
    it("passes onStartMentoring through to the task card and calls it with the clicked task itself (S1a)", () => {
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

      expect(onStartMentoring).toHaveBeenCalledWith(task);
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

    // Issue #489 (S1a・決定8): 可否も判断せずそのまま中継する（判断は
    // AppLayout が持つ）。
    it("passes startMentoringDisabled through to the task card", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks: [task] })}
          onStartMentoring={vi.fn()}
          startMentoringDisabled
        />,
      );

      expect(
        screen.getByRole("button", { name: "メンタリングする" }),
      ).toBeDisabled();
    });

    it("leaves the mentoring button enabled when startMentoringDisabled is false", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks: [task] })}
          onStartMentoring={vi.fn()}
          startMentoringDisabled={false}
        />,
      );

      expect(
        screen.getByRole("button", { name: "メンタリングする" }),
      ).toBeEnabled();
    });
  });

  // Issue #557 (S2a, 親 #438 決定14): 振り返り導線も `onStartMentoring` と
  // 同じく中継するだけで、判断には関与しない。
  describe("onShowTaskRecords passthrough (Issue #557, S2a)", () => {
    it("passes onShowTaskRecords through to the task card and calls it with the clicked task itself", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });
      const onShowTaskRecords = vi.fn();

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks: [task] })}
          onShowTaskRecords={onShowTaskRecords}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "記録を見る" }));

      expect(onShowTaskRecords).toHaveBeenCalledWith(task);
    });

    // 会中（`onStartMentoring = null`）でも導線の中継は止めない。
    it("renders the button on every card even when onStartMentoring is null", () => {
      const tasks = [
        makeTask({ id: 7, title: "資料を作る", status: "todo" }),
        makeTask({ id: 8, title: "レビューする", status: "in_progress" }),
      ];

      render(
        <TaskBoard
          tasksState={makeTasksState({ tasks })}
          onStartMentoring={null}
          onShowTaskRecords={vi.fn()}
        />,
      );

      expect(screen.getAllByRole("button", { name: "記録を見る" })).toHaveLength(
        2,
      );
    });

    it("does not render the button when onShowTaskRecords is not provided", () => {
      const task = makeTask({ id: 7, title: "資料を作る", status: "todo" });

      render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

      expect(
        screen.queryByRole("button", { name: "記録を見る" }),
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
      expandTerminalColumn("完了");
      expandTerminalColumn("中止");

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
      expandTerminalColumn("完了");

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
      expandTerminalColumn("完了");

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
      expandTerminalColumn("完了");

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

      const doneColumn = expandTerminalColumn("完了");
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

      const doneColumn = expandTerminalColumn("完了");
      expect(
        within(doneColumn).getByText("下限ちょうどに完了したタスク"),
      ).toBeInTheDocument();

      const droppedColumn = expandTerminalColumn("中止");
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

      const droppedColumn = expandTerminalColumn("中止");
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

      const droppedColumn = expandTerminalColumn("中止");
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
      expandTerminalColumn("中止");
      expect(screen.queryByText("古い中止タスク")).not.toBeInTheDocument();

      rerender(
        <TaskBoard
          tasksState={makeTasksState({
            tasks: [{ ...stale, updated_at: localIso(2026, 8, 10, 9) }],
          })}
        />,
      );

      // rerender は同一インスタンスを保つため、展開状態はそのまま保持される。
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
      expandTerminalColumn("完了");

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

      const doneColumn = expandTerminalColumn("完了");
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

      const doneColumn = expandTerminalColumn("完了");
      expect(within(doneColumn).getAllByRole("listitem")).toHaveLength(2);
    });

    it("labels the 完了 heading with the window length and in-window count (AC-16, #515 決定2改訂)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      // 定数を import せずリテラルで固定する（AC-38 の変異確認を成立させる）。
      // アンカー付きで完全一致にし、日数・件数表示以外の後付け（決定 6 の
      // 却下事項）が素通りしないようにする。tasks が空なので 0 件。
      expect(
        within(doneColumn).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(/^完了（直近 7 日・0 件）$/);
    });

    it("labels the 中止 heading with the window length and in-window count (AC-17, #515 決定2改訂)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByRole("heading", { level: 2 }),
      ).toHaveTextContent(/^中止（直近 7 日・0 件）$/);
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

  // 「完了」「中止」列を既定で畳み、開閉トグルで出し分ける（#515）。
  describe("完了/中止 列の既定折りたたみと開閉 (#515)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("collapses 完了 and 中止 by default and hides their in-window cards", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "窓内の完了タスク",
          status: "done",
          completed_at: localIso(2026, 8, 10, 9),
        }),
        makeTask({
          id: 2,
          title: "窓内の中止タスク",
          status: "dropped",
          updated_at: localIso(2026, 8, 10, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      const doneToggle = within(doneColumn).getByRole("button", {
        name: /^完了（直近 \d+ 日・\d+ 件）$/,
      });
      expect(doneToggle).toHaveAttribute("aria-expanded", "false");
      expect(
        within(doneColumn).queryByRole("listitem"),
      ).not.toBeInTheDocument();

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      const droppedToggle = within(droppedColumn).getByRole("button", {
        name: /^中止（直近 \d+ 日・\d+ 件）$/,
      });
      expect(droppedToggle).toHaveAttribute("aria-expanded", "false");
      expect(
        within(droppedColumn).queryByRole("listitem"),
      ).not.toBeInTheDocument();
    });

    it("expands 完了 and shows its in-window card on toggle click, and collapses again on a second click", () => {
      const task = makeTask({
        id: 1,
        title: "窓内の完了タスク",
        status: "done",
        completed_at: localIso(2026, 8, 10, 9),
      });

      render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

      const doneColumn = expandTerminalColumn("完了");
      expect(
        within(doneColumn).getByText("窓内の完了タスク"),
      ).toBeInTheDocument();

      const doneToggle = within(doneColumn).getByRole("button", {
        name: /^完了（直近 \d+ 日・\d+ 件）$/,
      });
      fireEvent.click(doneToggle);

      expect(doneToggle).toHaveAttribute("aria-expanded", "false");
      expect(
        within(doneColumn).queryByText("窓内の完了タスク"),
      ).not.toBeInTheDocument();
    });

    it("expands 中止 independently of 完了 (toggling one does not affect the other, both directions)", () => {
      render(<TaskBoard tasksState={makeTasksState()} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      const doneToggle = within(doneColumn).getByRole("button", {
        name: /^完了（直近 \d+ 日・\d+ 件）$/,
      });
      const droppedColumn = screen.getByRole("region", { name: "中止" });
      const droppedToggle = within(droppedColumn).getByRole("button", {
        name: /^中止（直近 \d+ 日・\d+ 件）$/,
      });

      // 完了だけを開いても中止は畳んだまま。
      expandTerminalColumn("完了");
      expect(doneToggle).toHaveAttribute("aria-expanded", "true");
      expect(droppedToggle).toHaveAttribute("aria-expanded", "false");

      // 続けて中止も開くと、完了は開いたまま中止も開く（アコーディオン化
      // していないこと。片方の開閉でもう片方が閉じる変異を検出する）。
      expandTerminalColumn("中止");
      expect(doneToggle).toHaveAttribute("aria-expanded", "true");
      expect(droppedToggle).toHaveAttribute("aria-expanded", "true");

      // 中止を畳んでも完了は開いたまま（閉じる操作でもう片方が道連れに
      // ならないこと。2 列で開閉状態を共有していないかを確認する）。
      fireEvent.click(droppedToggle);
      expect(doneToggle).toHaveAttribute("aria-expanded", "true");
      expect(droppedToggle).toHaveAttribute("aria-expanded", "false");
    });

    it("does not show an out-of-window 完了 task even after expanding the column", () => {
      const task = makeTask({
        id: 1,
        title: "窓外の完了タスク",
        status: "done",
        completed_at: localIso(2026, 8, 3, 23, 59, 59),
      });

      render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

      expandTerminalColumn("完了");

      expect(screen.queryByText("窓外の完了タスク")).not.toBeInTheDocument();
    });

    it("does not render a toggle on 未着手/進行中/一時停止 columns and always shows their cards", () => {
      const tasks = [
        makeTask({ id: 1, title: "todoのタスク", status: "todo" }),
        makeTask({ id: 2, title: "進行中のタスク", status: "in_progress" }),
        makeTask({ id: 3, title: "一時停止のタスク", status: "paused" }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      for (const label of ["未着手", "進行中", "一時停止"]) {
        const column = screen.getByRole("region", { name: label });
        // TaskCard 自身の「編集」ボタン等は残るため、見出しの中にボタンが
        // 無いことと、aria-expanded を持つボタンが列に無いことで確認する。
        expect(
          within(
            within(column).getByRole("heading", { level: 2 }),
          ).queryByRole("button"),
        ).not.toBeInTheDocument();
        expect(
          within(column)
            .queryAllByRole("button")
            .filter((button) => button.hasAttribute("aria-expanded")),
        ).toEqual([]);
      }
      expect(screen.getByText("todoのタスク")).toBeInTheDocument();
      expect(screen.getByText("進行中のタスク")).toBeInTheDocument();
      expect(screen.getByText("一時停止のタスク")).toBeInTheDocument();
    });

    it("resets both toggles to collapsed when TaskBoard is unmounted and remounted (tab switch, decision 3)", () => {
      const { unmount } = render(<TaskBoard tasksState={makeTasksState()} />);

      expandTerminalColumn("完了");
      expandTerminalColumn("中止");

      unmount();

      render(<TaskBoard tasksState={makeTasksState()} />);

      const doneToggle = screen.getByRole("button", {
        name: /^完了（直近 \d+ 日・\d+ 件）$/,
      });
      const droppedToggle = screen.getByRole("button", {
        name: /^中止（直近 \d+ 日・\d+ 件）$/,
      });
      expect(doneToggle).toHaveAttribute("aria-expanded", "false");
      expect(droppedToggle).toHaveAttribute("aria-expanded", "false");
    });
  });

  // 見出しの窓内件数表示（#428 決定6の改訂、#515 決定2）。
  describe("見出しの件数表示 (#515 決定2)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("names the 完了 toggle with the in-window count, excluding out-of-window and null completed_at tasks", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "窓内1",
          status: "done",
          completed_at: localIso(2026, 8, 10, 9),
        }),
        makeTask({
          id: 2,
          title: "窓内2",
          status: "done",
          completed_at: localIso(2026, 8, 6, 9),
        }),
        makeTask({
          id: 3,
          title: "窓外1",
          status: "done",
          completed_at: localIso(2026, 8, 1, 9),
        }),
        makeTask({
          id: 4,
          title: "窓外2",
          status: "done",
          completed_at: localIso(2026, 7, 20, 9),
        }),
        makeTask({
          id: 5,
          title: "窓外3(null)",
          status: "done",
          completed_at: null,
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(
        within(doneColumn).getByRole("button", {
          name: "完了（直近 7 日・2 件）",
        }),
      ).toBeInTheDocument();
    });

    it("names the 中止 toggle with the in-window count based on updated_at", () => {
      const tasks = [
        makeTask({
          id: 1,
          title: "窓内",
          status: "dropped",
          updated_at: localIso(2026, 8, 10, 9),
        }),
        makeTask({
          id: 2,
          title: "窓外",
          status: "dropped",
          updated_at: localIso(2026, 8, 1, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const droppedColumn = screen.getByRole("region", { name: "中止" });
      expect(
        within(droppedColumn).getByRole("button", {
          name: "中止（直近 7 日・1 件）",
        }),
      ).toBeInTheDocument();
    });

    it("names the 完了 toggle with 0 件 when there are no in-window done tasks", () => {
      // 窓外の done だけがある状態（status の一致だけで数えると 1 件になる）。
      const tasks = [
        makeTask({
          id: 1,
          title: "窓外",
          status: "done",
          completed_at: localIso(2026, 8, 1, 9),
        }),
      ];

      render(<TaskBoard tasksState={makeTasksState({ tasks })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(
        within(doneColumn).getByRole("button", {
          name: "完了（直近 7 日・0 件）",
        }),
      ).toBeInTheDocument();
    });

    it("keeps the toggle's accessible name unchanged before and after expanding", () => {
      const task = makeTask({
        id: 1,
        title: "窓内",
        status: "done",
        completed_at: localIso(2026, 8, 10, 9),
      });

      render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

      const doneColumn = screen.getByRole("region", { name: "完了" });
      const toggle = within(doneColumn).getByRole("button", {
        name: "完了（直近 7 日・1 件）",
      });

      fireEvent.click(toggle);

      expect(
        within(doneColumn).getByRole("button", {
          name: "完了（直近 7 日・1 件）",
        }),
      ).toBe(toggle);
    });
  });

  // 畳んだ列でもドロップ先として機能する（#515 決定4）。
  describe("畳んだ列へのドロップ (#515 決定4)", () => {
    it("calls editTask with status done when a card is dropped into the collapsed 完了 column", async () => {
      const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
      const tasksState = makeTasksState({ tasks: [task] });

      render(<TaskBoard tasksState={tasksState} />);

      const dataTransfer = makeDataTransfer(1);
      const doneColumn = screen.getByRole("region", { name: "完了" });
      fireEvent.dragOver(doneColumn, { dataTransfer });
      fireEvent.drop(doneColumn, { dataTransfer });

      await waitFor(() =>
        expect(tasksState.editTask).toHaveBeenCalledWith(1, {
          status: "done",
        }),
      );
    });

    it("calls editTask with status dropped when a card is dropped into the collapsed 中止 column", async () => {
      const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
      const tasksState = makeTasksState({ tasks: [task] });

      render(<TaskBoard tasksState={tasksState} />);

      const dataTransfer = makeDataTransfer(1);
      const droppedColumn = screen.getByRole("region", { name: "中止" });
      fireEvent.dragOver(droppedColumn, { dataTransfer });
      fireEvent.drop(droppedColumn, { dataTransfer });

      await waitFor(() =>
        expect(tasksState.editTask).toHaveBeenCalledWith(1, {
          status: "dropped",
        }),
      );
    });

    it("highlights the collapsed 完了 column while dragging a card over it", () => {
      const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
      const tasksState = makeTasksState({ tasks: [task] });

      render(<TaskBoard tasksState={tasksState} />);

      const dataTransfer = makeDataTransfer();
      const card = screen.getByText("todoのタスク").closest(".task-card");
      const doneColumn = screen.getByRole("region", { name: "完了" });
      expect(
        within(doneColumn).getByRole("button", {
          name: /^完了（直近 \d+ 日・\d+ 件）$/,
        }),
      ).toHaveAttribute("aria-expanded", "false");

      fireEvent.dragStart(card as Element, { dataTransfer });
      fireEvent.dragEnter(doneColumn, { dataTransfer });

      expect(doneColumn).toHaveClass("task-column-drag-over");
    });

    it("keeps the 完了 toggle collapsed after a card is dropped into it", async () => {
      const task = makeTask({ id: 1, title: "todoのタスク", status: "todo" });
      const tasksState = makeTasksState({ tasks: [task] });

      render(<TaskBoard tasksState={tasksState} />);

      const dataTransfer = makeDataTransfer(1);
      const doneColumn = screen.getByRole("region", { name: "完了" });
      const doneToggle = within(doneColumn).getByRole("button", {
        name: /^完了（直近 \d+ 日・\d+ 件）$/,
      });
      expect(doneToggle).toHaveAttribute("aria-expanded", "false");

      fireEvent.dragOver(doneColumn, { dataTransfer });
      fireEvent.drop(doneColumn, { dataTransfer });

      await waitFor(() =>
        expect(tasksState.editTask).toHaveBeenCalledWith(1, {
          status: "done",
        }),
      );

      expect(doneToggle).toHaveAttribute("aria-expanded", "false");
    });
  });
  // Issue #713 / #561 S3（決定12）: `todo` で「未確認」のカードの印。印は文言
  // 「未確認」を含むテキストで、取得中・失敗時は `estimated_minutes === null`
  // のカードにだけ出す。
  describe("タスクカードの未確認の印 (Issue #713, #561 S3)", () => {
    const MARK = "未確認";

    function mentoringRecord(
      taskId: number,
      overrides: Partial<DecisionRecord> = {},
    ): DecisionRecord {
      return {
        id: 500 + taskId,
        session_id: 1,
        task_id: taskId,
        task_title: `task-${taskId}`,
        content: "進め方を確認した",
        rationale: null,
        status: "active",
        kind: "mentoring",
        created_at: "2026-07-05T00:00:00.000Z",
        ...overrides,
      };
    }

    /** `GET /api/decisions` を成功（records）で返す fetch を差し込む。 */
    function stubDecisions(records: DecisionRecord[]) {
      const fetchMock = vi.fn((url: string) =>
        url === "/api/decisions"
          ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(records) })
          : Promise.reject(new Error(`unexpected fetch call: ${url}`)),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    /** `GET /api/decisions` を失敗（500）で返す fetch を差し込む。 */
    function stubDecisionsFailure() {
      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: "boom" }),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    /** `GET /api/decisions` を解決しない fetch に差し込む（取得中のまま）。 */
    function stubDecisionsPending() {
      const fetchMock = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    /** 保留中の応答チェーン（fetch → json → setState）を流し切る。 */
    async function flushAsync(): Promise<void> {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    function cardOf(title: string): HTMLElement {
      const card = screen
        .getByRole("heading", { name: title })
        .closest(".task-card");
      if (!(card instanceof HTMLElement)) {
        throw new Error(`task card not found: ${title}`);
      }
      return card;
    }

    describe("印が出る", () => {
      it("shows the mark on a todo task whose estimate is empty (AC-56)", async () => {
        stubDecisions([]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: null });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

        await waitFor(() =>
          expect(within(cardOf("資料を作る")).getByText(MARK)).toBeInTheDocument(),
        );
      });

      it("shows the mark on an estimated todo task that has no mentoring record once the lookup completes (AC-57)", async () => {
        stubDecisions([]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

        await waitFor(() =>
          expect(within(cardOf("資料を作る")).getByText(MARK)).toBeInTheDocument(),
        );
      });

      it("shows the mark when the task's only records are kind decision (AC-58)", async () => {
        stubDecisions([mentoringRecord(1, { kind: "decision" })]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);

        await waitFor(() =>
          expect(within(cardOf("資料を作る")).getByText(MARK)).toBeInTheDocument(),
        );
      });

      it("shows the mark on an unestimated todo task even when the decisions fetch fails (AC-59)", async () => {
        const fetchMock = stubDecisionsFailure();
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: null });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/decisions"));
        await flushAsync();

        expect(within(cardOf("資料を作る")).getByText(MARK)).toBeInTheDocument();
      });

      it("fetches GET /api/decisions exactly once on mount (FR-20)", async () => {
        const fetchMock = stubDecisions([]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);
        await flushAsync();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/decisions");
      });
    });

    describe("印が出ない", () => {
      // 兄弟の sentinel（記録なし・見積もり済み＝取得完了後に必ず印が出る）が
      // 印を出すのを待ってから、対象のカードに印が無いことを確かめる。取得が
      // 完了する前の「まだ印が出ていない」を不在の根拠にしないため。
      async function sentinelMarked() {
        await waitFor(() =>
          expect(within(cardOf("sentinel")).getByText(MARK)).toBeInTheDocument(),
        );
      }
      const sentinel = () =>
        makeTask({ id: 99, title: "sentinel", status: "todo", estimated_minutes: 10 });

      it("does not show the mark on an estimated todo task with a mentoring record (AC-60)", async () => {
        stubDecisions([mentoringRecord(1)]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task, sentinel()] })} />);
        await sentinelMarked();

        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
      });

      it("counts a withdrawn mentoring record as confirmed (AC-61)", async () => {
        stubDecisions([mentoringRecord(1, { status: "withdrawn" })]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task, sentinel()] })} />);
        await sentinelMarked();

        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
      });

      it("treats an estimate of 0 as an estimate: no mark when a mentoring record exists (AC-62)", async () => {
        stubDecisions([mentoringRecord(1)]);
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 0 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task, sentinel()] })} />);
        await sentinelMarked();

        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
      });

      // 4 つの状態それぞれでカードを実際に描画させ、そのカードに印が無いことを
      // 確かめる（描画されていないカードで「印が無い」は恒真になる）。
      // done / dropped は既定で畳まれ、直近 7 日の窓がある（#428・#515）。
      it.each([
        ["in_progress", "進行中"],
        ["paused", "一時停止"],
        ["done", "完了"],
        ["dropped", "中止"],
      ] as const)(
        "does not show the mark on an unestimated %s task (AC-63)",
        async (status, columnLabel) => {
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(NOW);
          stubDecisions([]);
          const task = makeTask({
            id: 1,
            title: "対象のタスク",
            status,
            estimated_minutes: null,
            completed_at: status === "done" ? localIso(2026, 8, 10, 9) : null,
            updated_at: localIso(2026, 8, 10, 9),
          });

          render(
            <TaskBoard tasksState={makeTasksState({ tasks: [task, sentinel()] })} />,
          );
          if (status === "done" || status === "dropped") {
            expandTerminalColumn(columnLabel as "完了" | "中止");
          }
          await sentinelMarked();

          const column = screen.getByRole("region", { name: columnLabel });
          expect(within(column).getByText("対象のタスク")).toBeInTheDocument();
          expect(within(cardOf("対象のタスク")).queryByText(MARK)).not.toBeInTheDocument();
        },
      );

      it("does not show the mark on an estimated todo task when the decisions fetch fails (AC-64)", async () => {
        const fetchMock = stubDecisionsFailure();
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task] })} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/decisions"));
        await flushAsync();

        expect(cardOf("資料を作る")).toBeInTheDocument();
        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
        // エラーは画面に出さない
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });

      it("does not show the mark on an estimated todo task while the decisions fetch is still pending (AC-65)", async () => {
        const fetchMock = stubDecisionsPending();
        const task = makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 });
        const unestimated = makeTask({ id: 2, title: "見積もり無し", status: "todo", estimated_minutes: null });

        render(<TaskBoard tasksState={makeTasksState({ tasks: [task, unestimated] })} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/decisions"));
        await flushAsync();

        // 見積もり無しの印は取得中でも出る（対の観測。取得中のまま描画されている）
        expect(within(cardOf("見積もり無し")).getByText(MARK)).toBeInTheDocument();
        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
      });
    });

    describe("状態の変化と表示の条件", () => {
      it("removes the mark from a card when its status is changed to in_progress, without refetching decisions (AC-66)", async () => {
        const fetchMock = stubDecisions([]);

        // 共有 tasks 状態の代役: editTask が status を更新して再描画させる
        function Harness() {
          const [tasks, setTasks] = useState<Task[]>([
            makeTask({ id: 1, title: "資料を作る", status: "todo", estimated_minutes: 30 }),
          ]);
          const tasksState = makeTasksState({
            tasks,
            editTask: vi.fn((id: number, patch: { status?: Task["status"] }) => {
              setTasks((current) =>
                current.map((t) => (t.id === id ? { ...t, ...patch } : t)),
              );
              return Promise.resolve();
            }) as unknown as UseTasksResult["editTask"],
          });
          return <TaskBoard tasksState={tasksState} />;
        }

        render(<Harness />);
        await waitFor(() =>
          expect(within(cardOf("資料を作る")).getByText(MARK)).toBeInTheDocument(),
        );

        fireEvent.change(within(cardOf("資料を作る")).getByLabelText("ステータス"), {
          target: { value: "in_progress" },
        });

        await waitFor(() =>
          expect(
            within(screen.getByRole("region", { name: "進行中" })).getByText("資料を作る"),
          ).toBeInTheDocument(),
        );
        expect(within(cardOf("資料を作る")).queryByText(MARK)).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });
});
