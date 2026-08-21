import { afterEach, describe, expect, it, vi } from "vitest";
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
});
