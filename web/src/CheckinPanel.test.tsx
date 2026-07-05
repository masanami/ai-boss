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

function createFetchMock(options: {
  tasks?: Task[];
  events?: ActivityEvent[];
  onCheckin?: (body: unknown) => CheckinResult;
}) {
  const { tasks = [], events = [], onCheckin } = options;

  return vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/tasks" && init === undefined) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tasks),
      });
    }
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
    vi.stubGlobal("fetch", createFetchMock({ tasks }));

    render(<CheckinPanel />);

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
    const fetchMock = createFetchMock({ tasks });
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel />);
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
    const fetchMock = createFetchMock({});
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel />);
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
    const fetchMock = createFetchMock({});
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel />);
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

    render(<CheckinPanel />);

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
      tasks,
      onCheckin: () => ({
        ok: false,
        status: 404,
        body: { error: "task 4 not found" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel />);
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "着手するタスク" }),
      ).toHaveValue("4"),
    );

    fireEvent.click(screen.getByRole("button", { name: "着手" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("task 4 not found"),
    );
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
    vi.stubGlobal("fetch", createFetchMock({ tasks, events }));

    render(<CheckinPanel />);

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
    const fetchMock = createFetchMock({ tasks });
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckinPanel />);
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
    vi.stubGlobal("fetch", createFetchMock({}));

    render(<CheckinPanel />);
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
    vi.stubGlobal("fetch", createFetchMock({ tasks }));

    render(<CheckinPanel />);
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

  it("shows an error message when today's activity fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    render(<CheckinPanel />);

    await waitFor(() =>
      expect(screen.getByText("活動の取得に失敗しました")).toBeInTheDocument(),
    );
  });
});
