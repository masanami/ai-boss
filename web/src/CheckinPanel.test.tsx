import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import CheckinPanel from "./CheckinPanel";
import type { ActivityEvent } from "./activity-event";
import type { Task } from "./task";
import type { UseTasksResult } from "./use-tasks";

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
    created_at: "2026-07-06T00:00:00.000Z",
    updated_at: "2026-07-06T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

// CheckinPanel は Issue #134 で AppLayout の共有 tasksState（UseTasksResult）
// を丸ごと受け取るようになった（tasks 配列だけでなく refresh も使うため）。
// editTask は Issue #138 の「完了」ボタンが選択中タスクを status: "done" に
// するために使うため、既定で解決済み Promise を返すダミーにしておき、
// テストごとに editTask/refresh を必要に応じて差し替えられるようにする。
// addTask は現状どのテストからも使われない。
function makeTasksState(
  tasks: Task[],
  overrides: Partial<UseTasksResult> = {},
): UseTasksResult {
  return {
    tasks,
    status: "ready",
    addTask: vi.fn(),
    editTask: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ActivityEvent> & { id: number }): ActivityEvent {
  return {
    type: "checkin",
    task_id: null,
    note: null,
    expected_minutes: null,
    created_at: "2026-07-06T09:00:00.000Z",
    ...overrides,
  };
}

interface CheckinResult {
  ok: boolean;
  status: number;
  body: unknown;
}

// tasks は AppLayout の共有状態から props で渡されるようになった（Issue #70）
// ため、fetch モックが受けるのはチェックイン系 API のみ。
function createFetchMock(options: {
  events?: ActivityEvent[];
  onCheckin?: (body: unknown) => CheckinResult;
} = {}) {
  const { events = [], onCheckin } = options;

  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/activity/today") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(events),
      });
    }
    if (url === "/api/checkins" && init?.method === "POST") {
      const parsedBody = JSON.parse(init.body as string) as unknown;
      const result = onCheckin
        ? onCheckin(parsedBody)
        : {
            ok: true,
            status: 201,
            body: {
              id: 999,
              ...(parsedBody as Record<string, unknown>),
              created_at: "2026-07-06T09:10:00.000Z",
            },
          };
      return Promise.resolve({
        ok: result.ok,
        status: result.status,
        json: () => Promise.resolve(result.body),
      });
    }
    return Promise.reject(new Error(`unexpected fetch call: ${url}`));
  });
}

describe("CheckinPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the highest-priority task and shows break controls when not on break", async () => {
    const tasks = [
      makeTask({ id: 1, title: "低優先タスク", priority: "low" }),
      makeTask({ id: 2, title: "高優先タスク", priority: "high" }),
    ];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("2"),
    );
    expect(screen.getByRole("button", { name: "着手" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "休憩" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "戻りました" }),
    ).not.toBeInTheDocument();
  });

  it("sends a task_start checkin with the selected task and note", async () => {
    const tasks = [makeTask({ id: 3, title: "資料作成", priority: "high" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("3"),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "ひとこと" }), {
      target: { value: "頑張ります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "task_start",
            task_id: 3,
            note: "頑張ります",
          }),
        }),
      ),
    );
  });

  it("sends a break_start checkin with the default 15-minute preset", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState([])} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "休憩" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "break_start",
            expected_minutes: 15,
            note: null,
          }),
        }),
      ),
    );
  });

  it("sends a break_start checkin with a custom minute value", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState([])} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "休憩時間" }), {
      target: { value: "custom" },
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "休憩時間（分・自由入力）" }),
      { target: { value: "45" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "休憩" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "break_start",
            expected_minutes: 45,
            note: null,
          }),
        }),
      ),
    );
  });

  it("shows the return button as the primary action while on break and sends break_end", async () => {
    const events = [
      makeEvent({ id: 1, type: "break_start", expected_minutes: 15 }),
    ];
    const fetchMock = createFetchMock({ events });
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState([])} />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "戻りました" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "着手" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "休憩" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "戻りました" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "break_end", note: null }),
        }),
      ),
    );
  });

  it("shows an error message when the checkin submission fails", async () => {
    const tasks = [makeTask({ id: 4, title: "資料作成", priority: "high" })];
    const fetchMock = createFetchMock({
      onCheckin: () => ({
        ok: false,
        status: 404,
        body: { error: "task 4 not found" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn().mockResolvedValue(undefined);

    render(<CheckinPanel tasksState={makeTasksState(tasks, { refresh })} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("4"),
    );

    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("task 4 not found"),
    );
    // 失敗時は共有 tasks の refresh を呼ばない（Issue #134）。
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls tasksState.refresh after a successful checkin (Issue #134)", async () => {
    const tasks = [makeTask({ id: 8, title: "資料作成", priority: "high" })];
    vi.stubGlobal("fetch", createFetchMock());
    const refresh = vi.fn().mockResolvedValue(undefined);

    render(<CheckinPanel tasksState={makeTasksState(tasks, { refresh })} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("8"),
    );

    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("renders task_pause as 一時停止 in today's activity (AC-14)", async () => {
    const tasks = [makeTask({ id: 5, title: "資料作成" })];
    const createdAt = "2026-07-06T09:20:00.000Z";
    const events = [
      makeEvent({
        id: 11,
        type: "task_pause",
        task_id: 5,
        created_at: createdAt,
      }),
    ];
    vi.stubGlobal("fetch", createFetchMock({ events }));

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    const list = await screen.findByRole("list");
    const item = await within(list).findByText("資料作成");
    expect(item.closest("li")).toHaveTextContent("一時停止");
  });

  it("renders today's activity with type, time, and task title", async () => {
    const tasks = [makeTask({ id: 5, title: "資料作成" })];
    const createdAt = "2026-07-06T09:15:00.000Z";
    const events = [
      makeEvent({
        id: 10,
        type: "task_start",
        task_id: 5,
        created_at: createdAt,
      }),
    ];
    vi.stubGlobal("fetch", createFetchMock({ events }));

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    // The rendered time is formatted in the local timezone, so the expected
    // value is derived the same way rather than hardcoded (which would be
    // flaky across machines/CI with a different TZ than JST).
    const expectedTime = new Date(createdAt).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const list = await screen.findByRole("list");
    const item = await within(list).findByText("資料作成");
    expect(item.closest("li")).toHaveTextContent("着手");
    expect(item.closest("li")).toHaveTextContent(expectedTime);
  });

  it("normalizes a whitespace-only note to null before sending", async () => {
    const tasks = [makeTask({ id: 6, title: "資料作成", priority: "high" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("6"),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "ひとこと" }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ type: "task_start", task_id: 6, note: null }),
        }),
      ),
    );
  });

  it("disables the break button when the custom minute value is not a positive integer", async () => {
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState([])} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "休憩時間" }), {
      target: { value: "custom" },
    });

    expect(screen.getByRole("button", { name: "休憩" })).toBeDisabled();

    fireEvent.change(
      screen.getByRole("spinbutton", { name: "休憩時間（分・自由入力）" }),
      { target: { value: "0" } },
    );
    expect(screen.getByRole("button", { name: "休憩" })).toBeDisabled();
  });

  it("clears the note field and shows a success message after a successful checkin", async () => {
    const tasks = [makeTask({ id: 7, title: "資料作成", priority: "high" })];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("7"),
    );

    const noteInput = screen.getByRole("textbox", { name: "ひとこと" });
    fireEvent.change(noteInput, { target: { value: "頑張ります" } });
    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() => expect(noteInput).toHaveValue(""));
    expect(screen.getByText("着手しました")).toBeInTheDocument();
  });

  it("resets the selection to the default task when the selected task leaves the selectable list", async () => {
    const taskA = makeTask({ id: 1, title: "タスクA", priority: "high" });
    const taskB = makeTask({ id: 2, title: "タスクB", priority: "low" });
    vi.stubGlobal("fetch", createFetchMock());

    const { rerender } = render(
      <CheckinPanel tasksState={makeTasksState([taskA, taskB])} />,
    );
    const combobox = screen.getByRole("combobox", { name: "着手するタスク" });
    await waitFor(() => expect(combobox).toHaveValue("1"));

    fireEvent.change(combobox, { target: { value: "2" } });
    expect(combobox).toHaveValue("2");

    // 選択中のタスクBが完了して selectable から外れる → デフォルト（タスクA）へ戻る
    rerender(
      <CheckinPanel
        tasksState={makeTasksState([
          taskA,
          makeTask({ id: 2, title: "タスクB", priority: "low", status: "done" }),
        ])}
      />,
    );

    await waitFor(() => expect(combobox).toHaveValue("1"));
  });

  it("reflects tasks added to the shared list without a reload", async () => {
    const taskA = makeTask({ id: 1, title: "タスクA", priority: "high" });
    vi.stubGlobal("fetch", createFetchMock());

    const { rerender } = render(
      <CheckinPanel tasksState={makeTasksState([taskA])} />,
    );
    const combobox = screen.getByRole("combobox", { name: "着手するタスク" });
    await waitFor(() => expect(combobox).toHaveValue("1"));

    // タスクボード側で作成 → 共有 tasks が更新される（Issue #70）
    const created = makeTask({ id: 2, title: "新しいタスク" });
    rerender(<CheckinPanel tasksState={makeTasksState([taskA, created])} />);

    expect(
      within(combobox).getByRole("option", { name: "新しいタスク" }),
    ).toBeInTheDocument();
  });

  it("disables the checkin buttons while a submission is in flight (double-click guard)", async () => {
    const tasks = [makeTask({ id: 5, title: "資料作成", priority: "high" })];
    let releasePost: (() => void) | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/activity/today") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([]),
        });
      }
      if (url === "/api/checkins" && init?.method === "POST") {
        return new Promise((resolve) => {
          releasePost = () =>
            resolve({
              ok: true,
              status: 201,
              json: () => Promise.resolve(makeEvent({ id: 9, type: "task_start" })),
            });
        });
      }
      return Promise.reject(new Error(`unexpected fetch call: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "着手" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "着手" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "休憩" })).toBeDisabled();

    releasePost?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "着手" })).toBeEnabled(),
    );
  });

  it("shows the 完了 button only when there is an in_progress task (Issue #138)", async () => {
    const tasks = [makeTask({ id: 1, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());

    const { rerender } = render(
      <CheckinPanel tasksState={makeTasksState(tasks)} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeInTheDocument(),
    );

    rerender(
      <CheckinPanel
        tasksState={makeTasksState([
          makeTask({ id: 1, title: "todoタスク", status: "todo" }),
        ])}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "完了" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("disables the 完了 button when the selected task is todo (Issue #138)", async () => {
    const tasks = [
      makeTask({ id: 1, title: "todoタスク", status: "todo", priority: "high" }),
      makeTask({ id: 2, title: "着手中タスク", status: "in_progress" }),
    ];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("1"),
    );

    expect(screen.getByRole("button", { name: "完了" })).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: "着手するタスク" }), {
      target: { value: "2" },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );
  });

  it("calls editTask with status done when 完了 is clicked (Issue #138)", async () => {
    const tasks = [makeTask({ id: 2, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());
    const editTask = vi.fn().mockResolvedValue(undefined);

    render(
      <CheckinPanel tasksState={makeTasksState(tasks, { editTask })} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "完了" }));

    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(2, { status: "done" }),
    );
  });

  it("shows 完了しました and reloads today's activity on successful completion (Issue #138)", async () => {
    const tasks = [makeTask({ id: 2, title: "着手中タスク", status: "in_progress" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const editTask = vi.fn().mockResolvedValue(undefined);

    render(
      <CheckinPanel tasksState={makeTasksState(tasks, { editTask })} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );
    const initialActivityCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/activity/today",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "完了" }));

    await waitFor(() =>
      expect(screen.getByText("完了しました")).toBeInTheDocument(),
    );
    await waitFor(() => {
      const activityCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/activity/today",
      ).length;
      expect(activityCalls).toBe(initialActivityCalls + 1);
    });
  });

  it("shows an alert with the error message when 完了 fails (Issue #138)", async () => {
    const tasks = [makeTask({ id: 2, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());
    const editTask = vi.fn().mockRejectedValue(new Error("task 2 not found"));

    render(
      <CheckinPanel tasksState={makeTasksState(tasks, { editTask })} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "完了" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("task 2 not found"),
    );
  });

  it("ignores a second 完了 click while one is in flight (double-click guard, Issue #138)", async () => {
    const tasks = [makeTask({ id: 2, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());
    let releaseEditTask: (() => void) | undefined;
    const editTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseEditTask = () => resolve(undefined);
        }),
    );

    render(
      <CheckinPanel tasksState={makeTasksState(tasks, { editTask })} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "完了" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "完了" }));

    releaseEditTask?.();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "完了" })).toBeEnabled(),
    );
    expect(editTask).toHaveBeenCalledTimes(1);
  });

  it("shows the 一時停止 button only when the selected task is in_progress (AC-1, G-179-1)", async () => {
    const tasks = [makeTask({ id: 1, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());

    const { rerender } = render(
      <CheckinPanel tasksState={makeTasksState(tasks)} />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "一時停止" }),
      ).toBeInTheDocument(),
    );

    rerender(
      <CheckinPanel
        tasksState={makeTasksState([
          makeTask({ id: 1, title: "todoタスク", status: "todo" }),
        ])}
      />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "一時停止" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not show the 一時停止 button when a different task is in_progress but the selected task is not (AC-1, G-179-1)", async () => {
    // 「完了」ボタンの hasInProgressTask パターン（一覧のどこかに in_progress
    // がある）と混同していないことの確認。一覧に in_progress のタスクが
    // 存在していても、選択中タスクが todo なら一時停止ボタンは出ない。
    const tasks = [
      makeTask({ id: 1, title: "todoタスク", status: "todo", priority: "high" }),
      makeTask({ id: 2, title: "着手中タスク", status: "in_progress" }),
    ];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("1"),
    );
    expect(
      screen.queryByRole("button", { name: "一時停止" }),
    ).not.toBeInTheDocument();
  });

  it("does not show the 一時停止 button when the selected task is paused", async () => {
    const tasks = [makeTask({ id: 1, title: "一時停止タスク", status: "paused" })];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("1"),
    );
    expect(
      screen.queryByRole("button", { name: "一時停止" }),
    ).not.toBeInTheDocument();
  });

  it("sends a task_pause checkin when 一時停止 is clicked", async () => {
    const tasks = [makeTask({ id: 2, title: "着手中タスク", status: "in_progress" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "一時停止" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "task_pause",
            task_id: 2,
            note: null,
          }),
        }),
      ),
    );
  });

  it("shows 再開 as the primary button label when the selected task is paused (AC-4, G-179-4)", async () => {
    const tasks = [makeTask({ id: 1, title: "一時停止タスク", status: "paused" })];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("1"),
    );
    expect(screen.getByRole("button", { name: "再開" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "着手" }),
    ).not.toBeInTheDocument();
  });

  it("sends the existing task_start checkin when 再開 is clicked for a paused task", async () => {
    const tasks = [makeTask({ id: 1, title: "一時停止タスク", status: "paused" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "再開" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "再開" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/checkins",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            type: "task_start",
            task_id: 1,
            note: null,
          }),
        }),
      ),
    );
  });

  it("shows 再開しました (not 着手しました) after resuming a paused task", async () => {
    const tasks = [makeTask({ id: 1, title: "一時停止タスク", status: "paused" })];
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "再開" })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "再開" }));

    await waitFor(() =>
      expect(screen.getByText("再開しました")).toBeInTheDocument(),
    );
    expect(screen.queryByText("着手しました")).not.toBeInTheDocument();
  });

  it("disables the primary button when the selected task is in_progress", async () => {
    const tasks = [makeTask({ id: 1, title: "着手中タスク", status: "in_progress" })];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("1"),
    );
    expect(screen.getByRole("button", { name: "着手" })).toBeDisabled();
  });

  it("includes paused tasks in the selectable task list", async () => {
    const tasks = [
      makeTask({ id: 1, title: "一時停止タスク", status: "paused" }),
    ];
    vi.stubGlobal("fetch", createFetchMock());

    render(<CheckinPanel tasksState={makeTasksState(tasks)} />);

    await waitFor(() =>
      expect(
        within(
          screen.getByRole("combobox", { name: "着手するタスク" }),
        ).getByRole("option", { name: "一時停止タスク" }),
      ).toBeInTheDocument(),
    );
  });

  it("shows an error message when today's activity fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    render(<CheckinPanel tasksState={makeTasksState([])} />);

    await waitFor(() =>
      expect(screen.getByText("活動の取得に失敗しました")).toBeInTheDocument(),
    );
  });

  // #351: 展開式の時刻指定欄（occurred_at 送信・休憩の開始＋戻り時刻の同時
  // 記録）。「いま」は 2026-09-05 09:00（ローカル）に固定し、時刻入力
  // ("HH:mm") から期待される occurred_at をこの日付基準で組み立てる。
  describe("time-specified recording (#351)", () => {
    const NOW = new Date(2026, 8, 5, 9, 0, 0, 0);

    function localTimeIso(hours: number, minutes: number): string {
      return new Date(2026, 8, 5, hours, minutes, 0, 0).toISOString();
    }

    function expandTimeInput() {
      fireEvent.click(
        screen.getByRole("button", { name: "時刻を指定して記録" }),
      );
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the collapsed layout unchanged and hides the time inputs (AC-30)", async () => {
      const tasks = [makeTask({ id: 1, title: "資料作成", priority: "high" })];
      vi.stubGlobal("fetch", createFetchMock());

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "着手するタスク" }),
        ).toHaveValue("1"),
      );

      expect(
        screen.getByRole("button", { name: "時刻を指定して記録" }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByLabelText("記録する時刻")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("戻り時刻（任意）"),
      ).not.toBeInTheDocument();
    });

    it("does not attach occurred_at when expanded but the time is left empty (AC-26)", async () => {
      const tasks = [makeTask({ id: 1, title: "資料作成", priority: "high" })];
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "着手するタスク" }),
        ).toHaveValue("1"),
      );
      expandTimeInput();

      fireEvent.click(screen.getByRole("button", { name: "着手" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/checkins",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              type: "task_start",
              task_id: 1,
              note: null,
            }),
          }),
        ),
      );
    });

    it("attaches occurred_at to task_start when a time is recorded (AC-18)", async () => {
      const tasks = [makeTask({ id: 1, title: "資料作成", priority: "high" })];
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "着手するタスク" }),
        ).toHaveValue("1"),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });

      fireEvent.click(screen.getByRole("button", { name: "着手" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/checkins",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              type: "task_start",
              task_id: 1,
              note: null,
              occurred_at: localTimeIso(8, 0),
            }),
          }),
        ),
      );
    });

    it("attaches occurred_at to task_pause when a time is recorded (AC-31)", async () => {
      const tasks = [
        makeTask({ id: 2, title: "着手中タスク", status: "in_progress" }),
      ];
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:15" },
      });

      fireEvent.click(screen.getByRole("button", { name: "一時停止" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/checkins",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              type: "task_pause",
              task_id: 2,
              note: null,
              occurred_at: localTimeIso(8, 15),
            }),
          }),
        ),
      );
    });

    it("attaches occurred_at to break_start when a time is recorded and the return time is empty (AC-20, AC-32)", async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/checkins",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              type: "break_start",
              expected_minutes: 15,
              note: null,
              occurred_at: localTimeIso(8, 0),
            }),
          }),
        ),
      );
      const checkinCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCalls).toHaveLength(1);
    });

    it("attaches occurred_at to break_end when 戻りました is recorded while on break (AC-25)", async () => {
      const events = [
        makeEvent({ id: 1, type: "break_start", expected_minutes: 15 }),
      ];
      const fetchMock = createFetchMock({ events });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "戻りました" }),
        ).toBeInTheDocument(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:30" },
      });
      // 戻り時刻を入力していないので「記録する時刻」がフォールバックとして
      // 使われる（判断6の再送経路で戻り時刻を優先するのとは別ケース）。

      fireEvent.click(screen.getByRole("button", { name: "戻りました" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/checkins",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              type: "break_end",
              note: null,
              occurred_at: localTimeIso(8, 30),
            }),
          }),
        ),
      );
    });

    it("sends break_start then break_end with the recorded start and return times (AC-19)", async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "08:30" },
      });

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() => {
        const checkinCalls = fetchMock.mock.calls.filter(
          ([url]) => url === "/api/checkins",
        );
        expect(checkinCalls).toHaveLength(2);
      });

      const checkinCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(JSON.parse(checkinCalls[0][1]?.body as string)).toEqual({
        type: "break_start",
        expected_minutes: 15,
        note: null,
        occurred_at: localTimeIso(8, 0),
      });
      expect(JSON.parse(checkinCalls[1][1]?.body as string)).toEqual({
        type: "break_end",
        note: null,
        occurred_at: localTimeIso(8, 30),
      });

      await waitFor(() =>
        expect(screen.getByText(/休憩を記録しました/)).toBeInTheDocument(),
      );
    });

    it("disables the break button and sends nothing when the return time is not after the start time (AC-21)", async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:30" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "08:00" },
      });

      expect(screen.getByRole("button", { name: "休憩" })).toBeDisabled();
      expect(
        screen.getByText("戻り時刻は記録する時刻より後にしてください"),
      ).toBeInTheDocument();

      const checkinCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCalls).toHaveLength(0);
    });

    it("disables the break button and sends nothing when the return time is in the future (AC-22)", async () => {
      const fetchMock = createFetchMock();
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "10:00" },
      });

      expect(screen.getByRole("button", { name: "休憩" })).toBeDisabled();

      const checkinCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCalls).toHaveLength(0);
    });

    it("disables 戻りました and shows a reason when the return time is in the future while on break (AC-22, AC-27 regression)", async () => {
      // セルフレビュー2周目の指摘: 戻り時刻を on-break でも保持・表示する
      // ようにした修正で、戻り時刻が未来のとき理由の表示なしに「戻りました」
      // だけが無効化される行き止まりが新たに生まれていた。ここで固定する。
      const events = [
        makeEvent({ id: 1, type: "break_start", expected_minutes: 15 }),
      ];
      vi.stubGlobal("fetch", createFetchMock({ events }));

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "戻りました" }),
        ).toBeInTheDocument(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "10:00" },
      });

      expect(screen.getByRole("button", { name: "戻りました" })).toBeDisabled();
      expect(
        screen.getByText("戻り時刻を未来にはできません"),
      ).toBeInTheDocument();
    });

    it("keeps break_start recorded, switches to the on-break display, and preserves the time inputs when break_end fails, and lets 戻りました retry with the preserved return time (AC-23, AC-24)", async () => {
      // createFetchMock の /api/activity/today は固定の events しか返せない
      // ため、break_start 成功後に isOnBreak が true へ切り替わる実際の
      // 挙動（セルフレビュー指摘: レビュー時点のテストは isOnBreak=false の
      // ままだったため、判断6の再送経路が全く検証されていなかった）を
      // 固定するには、記録済みイベントを反映する専用のモックを使う。
      let recordedEvents: ActivityEvent[] = [];
      let breakEndAttempts = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(recordedEvents),
          });
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as {
            type: ActivityEvent["type"];
            task_id?: number | null;
            note?: string | null;
            expected_minutes?: number | null;
          };
          if (parsedBody.type === "break_end") {
            breakEndAttempts += 1;
            if (breakEndAttempts === 1) {
              return Promise.resolve({
                ok: false,
                status: 400,
                json: () =>
                  Promise.resolve({
                    error: "break_end must be after break_start",
                  }),
              });
            }
          }
          const created: ActivityEvent = {
            id: recordedEvents.length + 1,
            type: parsedBody.type,
            task_id: parsedBody.task_id ?? null,
            note: parsedBody.note ?? null,
            expected_minutes: parsedBody.expected_minutes ?? null,
            created_at: "2026-09-05T08:00:00.000Z",
          };
          recordedEvents = [...recordedEvents, created];
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(created),
          });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "08:30" },
      });

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "break_end must be after break_start",
        ),
      );

      // break_start は取り消されず、活動一覧に反映されて表示が
      // 「戻りました」（on-break）に切り替わる（AC-23）。
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "戻りました" }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("button", { name: "休憩" }),
      ).not.toBeInTheDocument();

      // 時刻指定欄は展開されたまま、開始時刻・戻り時刻の入力値が保持される
      // （AC-24）。
      expect(screen.getByLabelText("記録する時刻")).toHaveValue("08:00");
      expect(screen.getByLabelText("戻り時刻（任意）")).toHaveValue("08:30");

      const checkinCallsAfterFailure = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCallsAfterFailure).toHaveLength(2);
      expect(
        JSON.parse(checkinCallsAfterFailure[0][1]?.body as string).type,
      ).toBe("break_start");

      // 保持された戻り時刻のまま「戻りました」で break_end だけを再送できる
      // （機能仕様 判断6「2 回目失敗後の再送もこの経路」）。
      fireEvent.click(screen.getByRole("button", { name: "戻りました" }));

      await waitFor(() =>
        expect(screen.getByText(/08:30に戻りました/)).toBeInTheDocument(),
      );

      const checkinCallsAfterRetry = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCallsAfterRetry).toHaveLength(3);
      expect(
        JSON.parse(checkinCallsAfterRetry[2][1]?.body as string),
      ).toEqual({
        type: "break_end",
        note: null,
        occurred_at: localTimeIso(8, 30),
      });
    });

    it("still sends break_end when break_start succeeded but the activity reload failed (Codex P1 on PR #354)", async () => {
      // /api/activity/today: 初回読み込みは成功、break_start 直後の再取得だけ
      // 失敗させる。再取得の一時的な失敗を 1 件目の失敗と区別できないと、
      // 2 件目の break_end が送られず休憩が開いたままになる。
      let activityCalls = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          activityCalls += 1;
          if (activityCalls === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve([]),
            });
          }
          return Promise.reject(new Error("network error"));
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                id: 1,
                ...parsedBody,
                created_at: "2026-09-05T08:00:00.000Z",
              }),
          });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "08:30" },
      });

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() =>
        expect(screen.getByText(/休憩を記録しました/)).toBeInTheDocument(),
      );
      const checkinCalls = fetchMock.mock.calls.filter(
        ([url]) => url === "/api/checkins",
      );
      expect(checkinCalls.map(([, init]) => JSON.parse(init?.body as string).type)).toEqual([
        "break_start",
        "break_end",
      ]);
      // 再取得の失敗は送信エラーとしては出ない（活動一覧側の表示に委ねる）。
      expect(screen.queryByRole("alert")).toHaveTextContent("活動の取得に失敗しました");
    });

    it("resends only break_end from the 休憩 button after break_end failed while a later closed break keeps the panel off-break (Codex P2 on PR #354)", async () => {
      // 後追いする休憩（08:00〜08:30）より後に閉じた休憩（10:00〜10:15）が
      // 既にあるため、break_start を記録しても isOnBreak は false のままで
      // 「戻りました」は出ない。「休憩」を押し直したときに break_start を
      // 二重に記録せず break_end だけを再送することを固定する。
      const laterBreak: ActivityEvent[] = [
        makeEvent({ id: 10, type: "break_start", created_at: localTimeIso(10, 0) }),
        makeEvent({ id: 11, type: "break_end", created_at: localTimeIso(10, 15) }),
      ];
      let breakEndAttempts = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(laterBreak),
          });
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as { type: string };
          if (parsedBody.type === "break_end") {
            breakEndAttempts += 1;
            if (breakEndAttempts === 1) {
              return Promise.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ error: "temporary failure" }),
              });
            }
          }
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ id: 1, ...parsedBody }),
          });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), {
        target: { value: "08:30" },
      });
      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("temporary failure"),
      );
      // 後続の閉じた休憩があるため「戻りました」には切り替わらない。
      expect(screen.queryByRole("button", { name: "戻りました" })).not.toBeInTheDocument();
      expect(screen.getByText(/08:00の休憩開始は記録済みです/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() =>
        expect(screen.getByText(/休憩を記録しました/)).toBeInTheDocument(),
      );
      const types = fetchMock.mock.calls
        .filter(([url]) => url === "/api/checkins")
        .map(([, init]) => JSON.parse(init?.body as string).type);
      expect(types).toEqual(["break_start", "break_end", "break_end"]);
      expect(screen.queryByText(/休憩開始は記録済みです/)).not.toBeInTheDocument();
    });

    it("resends only break_end with the retained return time after collapsing the time controls while pending (Codex P2 on PR #356/#357, off-break)", async () => {
      // 後続の閉じた休憩があるため isOnBreak は false のまま。保留中に展開欄を
      // 折りたたんでから「休憩」を押しても、新しい break_start を二重記録せず
      // 保留時の戻り時刻で break_end だけを再送することを固定する。
      const laterBreak: ActivityEvent[] = [
        makeEvent({ id: 10, type: "break_start", created_at: localTimeIso(10, 0) }),
        makeEvent({ id: 11, type: "break_end", created_at: localTimeIso(10, 15) }),
      ];
      let breakEndAttempts = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(laterBreak) });
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as { type: string };
          if (parsedBody.type === "break_end") {
            breakEndAttempts += 1;
            if (breakEndAttempts === 1) {
              return Promise.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ error: "temporary failure" }),
              });
            }
          }
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ id: 1, ...parsedBody }) });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled());
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), { target: { value: "08:00" } });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), { target: { value: "08:30" } });
      fireEvent.click(screen.getByRole("button", { name: "休憩" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("temporary failure"));

      // 展開欄を折りたたむ。保留バナーは折りたたんでも見える。
      fireEvent.click(screen.getByRole("button", { name: "時刻を指定して記録" }));
      expect(screen.queryByLabelText("記録する時刻")).not.toBeInTheDocument();
      expect(screen.getByText(/08:00の休憩開始は記録済みです/)).toHaveTextContent("08:30");

      fireEvent.click(screen.getByRole("button", { name: "休憩" }));
      await waitFor(() => expect(screen.getByText(/08:00〜08:30の休憩を記録しました/)).toBeInTheDocument());

      const bodies = fetchMock.mock.calls
        .filter(([url]) => url === "/api/checkins")
        .map(([, init]) => JSON.parse(init?.body as string) as { type: string; occurred_at?: string });
      expect(bodies.map((b) => b.type)).toEqual(["break_start", "break_end", "break_end"]);
      expect(bodies[2].occurred_at).toBe(localTimeIso(8, 30));
      expect(screen.queryByText(/休憩開始は記録済みです/)).not.toBeInTheDocument();
    });

    it("sends break_end with the retained return time (not now) from 戻りました after collapsing the time controls while pending (Codex P2 on PR #356/#357, on-break)", async () => {
      let recordedEvents: ActivityEvent[] = [];
      let breakEndAttempts = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(recordedEvents) });
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as {
            type: ActivityEvent["type"];
            occurred_at?: string;
          };
          if (parsedBody.type === "break_end") {
            breakEndAttempts += 1;
            if (breakEndAttempts === 1) {
              return Promise.resolve({
                ok: false,
                status: 500,
                json: () => Promise.resolve({ error: "temporary failure" }),
              });
            }
          }
          const created = makeEvent({
            id: recordedEvents.length + 1,
            type: parsedBody.type,
            created_at: parsedBody.occurred_at ?? localTimeIso(12, 0),
          });
          recordedEvents = [...recordedEvents, created];
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve(created) });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled());
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), { target: { value: "08:00" } });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), { target: { value: "08:30" } });
      fireEvent.click(screen.getByRole("button", { name: "休憩" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "戻りました" })).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "時刻を指定して記録" }));
      expect(screen.queryByLabelText("戻り時刻（任意）")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "戻りました" }));
      await waitFor(() => expect(screen.getByText(/08:30に戻りました/)).toBeInTheDocument());

      const bodies = fetchMock.mock.calls
        .filter(([url]) => url === "/api/checkins")
        .map(([, init]) => JSON.parse(init?.body as string) as { type: string; occurred_at?: string });
      expect(bodies.map((b) => b.type)).toEqual(["break_start", "break_end", "break_end"]);
      // 現在時刻ではなく保留時の戻り時刻で閉じる。
      expect(bodies[2].occurred_at).toBe(localTimeIso(8, 30));
      expect(screen.queryByText(/休憩開始は記録済みです/)).not.toBeInTheDocument();
    });

    it("treats a lost break_end response as completed when the refreshed activity already contains that break_end (Codex P2 on PR #356/#357)", async () => {
      // サーバは break_end をコミットしたが応答の解釈に失敗するケース。
      // 再取得した一覧に同時刻の break_end があれば完了扱いにし、保留にしない
      // （保留にすると再送が同時刻重複の 400 で永久に弾かれる）。
      let recordedEvents: ActivityEvent[] = [];
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/activity/today") {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(recordedEvents) });
        }
        if (url === "/api/checkins" && init?.method === "POST") {
          const parsedBody = JSON.parse(init.body as string) as {
            type: ActivityEvent["type"];
            occurred_at?: string;
          };
          const created = makeEvent({
            id: recordedEvents.length + 1,
            type: parsedBody.type,
            created_at: parsedBody.occurred_at ?? localTimeIso(12, 0),
          });
          recordedEvents = [...recordedEvents, created];
          if (parsedBody.type === "break_end") {
            return Promise.resolve({
              ok: true,
              status: 201,
              json: () => Promise.reject(new Error("response body lost")),
            });
          }
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve(created) });
        }
        return Promise.reject(new Error(`unexpected fetch call: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<CheckinPanel tasksState={makeTasksState([])} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "休憩" })).toBeEnabled());
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), { target: { value: "08:00" } });
      fireEvent.change(screen.getByLabelText("戻り時刻（任意）"), { target: { value: "08:30" } });
      fireEvent.click(screen.getByRole("button", { name: "休憩" }));

      await waitFor(() => expect(screen.getByText(/08:00〜08:30の休憩を記録しました/)).toBeInTheDocument());
      expect(screen.queryByText(/休憩開始は記録済みです/)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      const checkinCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/checkins");
      expect(checkinCalls).toHaveLength(2);
    });

    it("disables the checkin buttons and shows a reason when the recorded time is in the future (AC-27)", async () => {
      const tasks = [
        makeTask({ id: 3, title: "着手中タスク", status: "in_progress" }),
      ];
      vi.stubGlobal("fetch", createFetchMock());

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled(),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "10:00" },
      });

      expect(screen.getByRole("button", { name: "着手" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "一時停止" })).toBeDisabled();
      expect(
        screen.getByText("記録する時刻を未来にはできません"),
      ).toBeInTheDocument();
    });

    it("includes a report re-generation note in the success feedback when a time is recorded (AC-28)", async () => {
      const tasks = [makeTask({ id: 1, title: "資料作成", priority: "high" })];
      vi.stubGlobal("fetch", createFetchMock());

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "着手するタスク" }),
        ).toHaveValue("1"),
      );
      expandTimeInput();
      fireEvent.change(screen.getByLabelText("記録する時刻"), {
        target: { value: "08:00" },
      });

      fireEvent.click(screen.getByRole("button", { name: "着手" }));

      await waitFor(() =>
        expect(screen.getByText(/日報を生成済みなら再生成が必要です/)).toBeInTheDocument(),
      );
    });

    it("keeps 着手/一時停止/戻りました enablement the same as collapsed when expanded without a time (AC-34)", async () => {
      const tasks = [
        makeTask({ id: 4, title: "着手中タスク", status: "in_progress" }),
      ];
      vi.stubGlobal("fetch", createFetchMock());

      render(<CheckinPanel tasksState={makeTasksState(tasks)} />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled(),
      );
      // 折りたたみ時の活性状態（ベースライン）
      expect(screen.getByRole("button", { name: "着手" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled();

      expandTimeInput();

      // 時刻未入力のまま展開しても活性条件は変わらない
      expect(screen.getByRole("button", { name: "着手" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "一時停止" })).toBeEnabled();
    });
  });
});
