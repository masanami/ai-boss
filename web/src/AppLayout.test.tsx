import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import AppLayout from "./AppLayout";
import type { ChatMessage, ChatSession } from "./chat";
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
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

// AppLayout はダッシュボード（既定ビュー）・チェックイン・共有 tasks を
// 同時に読み込むため、統合テストでは URL でルーティングする fetch モックを使う。
function createRoutedFetchMock(options: {
  tasks?: Task[];
  onCreateTask?: (body: unknown) => Task;
  onPatchTask?: (id: number, body: unknown) => Task;
  /** Issue #134: called on POST /api/checkins with the parsed body and the
   * current task list; returns the task list that a subsequent GET
   * /api/tasks (triggered by the checkin-success refresh) should see. This
   * simulates the server-side status transitions from Issue #133 (e.g.
   * task_start moving a task to in_progress) without re-implementing them
   * here. */
  onCheckin?: (body: unknown, tasks: Task[]) => Task[];
  sessions?: ChatSession[];
  sessionMessages?: Record<number, ChatMessage[]>;
} = {}) {
  const {
    tasks: initialTasks = [],
    onCreateTask,
    onPatchTask,
    onCheckin,
    sessions = [],
    sessionMessages = {},
  } = options;
  let tasks = initialTasks;

  const jsonResponse = (status: number, body: unknown) =>
    Promise.resolve({
      ok: true,
      status,
      json: () => Promise.resolve(body),
    });

  return vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/health") {
      return jsonResponse(200, { status: "ok" });
    }
    if (url === "/api/dashboard") {
      return jsonResponse(200, {
        progress: { done: 0, total: 0, ratio: 0 },
        morningSessionHeld: false,
        eveningSessionHeld: false,
        todayMaxEscalationLevel: 0,
        bossComment: "今日も頼むぞ。",
        date: "2026-07-27",
      });
    }
    if (url === "/api/activity/today") {
      return jsonResponse(200, []);
    }
    if (url === "/api/reports" && method === "GET") {
      return jsonResponse(200, []);
    }
    if (/^\/api\/reports\/\d{4}-\d{2}-\d{2}$/.test(url) && method === "GET") {
      return jsonResponse(404, {
        error: "report not found",
        code: "report_not_found",
      });
    }
    if (url === "/api/tasks" && method === "GET") {
      return jsonResponse(200, tasks);
    }
    if (url === "/api/tasks" && method === "POST" && onCreateTask) {
      const created = onCreateTask(JSON.parse(init?.body as string) as unknown);
      // Keep the mutable `tasks` list consistent with what onCreateTask
      // returned, so a later GET /api/tasks (e.g. triggered by the checkin
      // refresh, Issue #134) doesn't roll back to the stale initial list.
      tasks = [...tasks, created];
      return jsonResponse(201, created);
    }
    const patchMatch = /^\/api\/tasks\/(\d+)$/.exec(url);
    if (patchMatch && method === "PATCH" && onPatchTask) {
      const updated = onPatchTask(
        Number(patchMatch[1]),
        JSON.parse(init?.body as string) as unknown,
      );
      tasks = tasks.map((t) => (t.id === updated.id ? updated : t));
      return jsonResponse(200, updated);
    }
    if (url === "/api/checkins" && method === "POST") {
      const body = JSON.parse(init?.body as string) as unknown;
      if (onCheckin) {
        tasks = onCheckin(body, tasks);
      }
      return jsonResponse(201, {
        id: 1,
        ...(body as Record<string, unknown>),
        created_at: "2026-07-27T09:00:00.000Z",
      });
    }
    // chatState (Issue #93: useChat is lifted up to AppLayout, so it fetches
    // on mount regardless of which view is active).
    if (url === "/api/sessions" && method === "GET") {
      return jsonResponse(200, sessions);
    }
    const messagesMatch = /^\/api\/sessions\/(\d+)\/messages$/.exec(url);
    if (messagesMatch && method === "GET") {
      return jsonResponse(200, sessionMessages[Number(messagesMatch[1])] ?? []);
    }
    return Promise.reject(new Error(`unexpected fetch call: ${method} ${url}`));
  });
}

beforeEach(() => {
  // Default stub is a fetch that never resolves, so layout-only tests never
  // trigger a post-render state update (and the resulting "not wrapped in
  // act" warning). Tests that care about the health check status override
  // this with a resolving/rejecting mock.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AppLayout", () => {
  it("renders the six nav placeholder items", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("navigation", { name: "メインナビゲーション" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "ダッシュボード" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "チャット" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "タスク" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "決定ログ" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日報" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "設定" })).toBeInTheDocument();
  });

  it("renders the dashboard as the default main view", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("main", { name: "ダッシュボード" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });

  it("switches the main area to the boss dialogue when the chat nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "チャット" }));

    expect(
      screen.getByRole("main", { name: "ボスとの対話" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ダッシュボード" }),
    ).not.toBeInTheDocument();
  });

  it("renders the right side panel with the today's tasks and progress sections", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("complementary", { name: "サイドパネル" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "今日のタスク" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "進捗" }),
    ).toBeInTheDocument();
  });

  it("shows today's tasks and norma progress in the side panel instead of the placeholders", async () => {
    const tasks = [makeTask({ id: 1, title: "資料を作る", status: "todo" })];
    vi.stubGlobal("fetch", createRoutedFetchMock({ tasks }));

    render(<AppLayout />);

    const sidePanel = screen.getByRole("complementary", {
      name: "サイドパネル",
    });
    await waitFor(() =>
      expect(within(sidePanel).getByText("□ 資料を作る")).toBeInTheDocument(),
    );
    expect(
      within(sidePanel).getByRole("progressbar", { name: "今日のノルマ進捗" }),
    ).toBeInTheDocument();
    expect(
      within(sidePanel).getByText("0 / 1 件完了（0%）"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/準備中/)).not.toBeInTheDocument();
  });

  it("reflects a task created on the board in the checkin selector without a reload", async () => {
    const created = makeTask({ id: 5, title: "新しいタスク", status: "todo" });
    vi.stubGlobal(
      "fetch",
      createRoutedFetchMock({ tasks: [], onCreateTask: () => created }),
    );

    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "未着手" })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "新しいタスク" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加" }));

    const combobox = screen.getByRole("combobox", { name: "着手するタスク" });
    await waitFor(() =>
      expect(
        within(combobox).getByRole("option", { name: "新しいタスク" }),
      ).toBeInTheDocument(),
    );
    // サイドパネルの「今日のタスク」にも反映される（Issue #71 案B）
    const sidePanel = screen.getByRole("complementary", {
      name: "サイドパネル",
    });
    expect(within(sidePanel).getByText("□ 新しいタスク")).toBeInTheDocument();
  });

  it("removes a task from the checkin selector when it is marked done on the board", async () => {
    const task = makeTask({ id: 1, title: "資料を作る", status: "todo" });
    vi.stubGlobal(
      "fetch",
      createRoutedFetchMock({
        tasks: [task],
        onPatchTask: () => ({
          ...task,
          status: "done",
          completed_at: new Date().toISOString(),
        }),
      }),
    );

    render(<AppLayout />);

    const combobox = screen.getByRole("combobox", { name: "着手するタスク" });
    await waitFor(() =>
      expect(
        within(combobox).getByRole("option", { name: "資料を作る" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    const todoColumn = await screen.findByRole("region", { name: "未着手" });
    await waitFor(() =>
      expect(within(todoColumn).getByText("資料を作る")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("ステータス"), {
      target: { value: "done" },
    });

    await waitFor(() =>
      expect(
        within(combobox).queryByRole("option", { name: "資料を作る" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("renders the checkin panel above the other side panel sections", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("region", { name: "チェックイン" }),
    ).toBeInTheDocument();
  });

  it("reflects a task's status change from a checkin on the task board without a reload (Issue #134)", async () => {
    const task = makeTask({ id: 1, title: "資料を作る", status: "todo" });
    vi.stubGlobal(
      "fetch",
      createRoutedFetchMock({
        tasks: [task],
        // Mirrors the server-side task_start -> in_progress transition from
        // Issue #133; this test only cares that the client refetches and
        // reflects it, not that the transition itself is correct.
        onCheckin: (body, tasks) => {
          const parsed = body as { type: string; task_id?: number };
          if (parsed.type !== "task_start") {
            return tasks;
          }
          return tasks.map((t) =>
            t.id === parsed.task_id ? { ...t, status: "in_progress" } : t,
          );
        },
      }),
    );

    render(<AppLayout />);

    // タスクボードを先にマウントしておく（TaskBoard 自身がマウント時に
    // 一度だけ refresh() する副作用 — TaskBoard.tsx 参照 — を「着手」より
    // 前に済ませ切る）。これをしないと、この後の「進行中」への反映が
    // ボードの再マウントによるものなのか CheckinPanel からの refresh 配線
    // （Issue #134 の本題）によるものなのか区別できないテストになる
    // （レビュー指摘）。サイドパネルは activeView に関わらず常時表示なので、
    // タスクビューに切り替えたままチェックインできる。
    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    const todoColumn = await screen.findByRole("region", { name: "未着手" });
    await waitFor(() =>
      expect(within(todoColumn).getByText("資料を作る")).toBeInTheDocument(),
    );

    const combobox = screen.getByRole("combobox", { name: "着手するタスク" });
    await waitFor(() => expect(combobox).toHaveValue("1"));

    fireEvent.click(screen.getByRole("button", { name: "着手" }));
    await waitFor(() =>
      expect(screen.getByText("着手しました")).toBeInTheDocument(),
    );

    const inProgressColumn = screen.getByRole("region", { name: "進行中" });
    await waitFor(() =>
      expect(
        within(inProgressColumn).getByText("資料を作る"),
      ).toBeInTheDocument(),
    );
  });

  it("renders the header title", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("heading", { name: "ai-boss" }),
    ).toBeInTheDocument();
  });

  it("shows the connected status in the header once the health check succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    render(<AppLayout />);

    await waitFor(() =>
      expect(screen.getByText("接続 OK")).toBeInTheDocument(),
    );
  });

  it("shows the disconnected status in the header when the health check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<AppLayout />);

    await waitFor(() =>
      expect(screen.getByText("サーバー未接続")).toBeInTheDocument(),
    );
  });

  it("switches the main area to the task board when the task nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));

    expect(
      screen.getByRole("main", { name: "タスクボード" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the chat placeholder from another view when the chat nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    fireEvent.click(screen.getByRole("button", { name: "チャット" }));

    expect(
      screen.getByRole("main", { name: "ボスとの対話" }),
    ).toBeInTheDocument();
  });

  it("switches back to the dashboard when the dashboard nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    fireEvent.click(screen.getByRole("button", { name: "ダッシュボード" }));

    expect(
      screen.getByRole("main", { name: "ダッシュボード" }),
    ).toBeInTheDocument();
  });

  it("switches the main area to the decision log when the decision log nav item is clicked", () => {
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "決定ログ" }));

    expect(
      screen.getByRole("main", { name: "決定ログ" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });

  it("switches the main area to the daily report view when the report nav item is clicked", () => {
    // 既定の（解決しない）fetch スタブのままでよい: main のラベル切り替えだけを
    // 確認する（決定ログ・設定の既存スイッチテストと同じ作法）。
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "日報" }));

    expect(screen.getByRole("main", { name: "日報" })).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the chat conversation across a chat -> tasks -> chat round trip (Issue #93)", async () => {
    // The chat conversation is now lifted up to AppLayout (Issue #93), so
    // switching away from and back to the chat tab must not lose it — this
    // is the direct regression test for the bug the ticket fixes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 5, 12, 0, 0));

    const chatSession: ChatSession = {
      id: 7,
      type: "adhoc",
      started_at: new Date(2026, 6, 5, 9, 0, 0).toISOString(),
      ended_at: null,
      summary: null,
    };
    const chatMessages: ChatMessage[] = [
      {
        id: 1,
        session_id: 7,
        role: "user",
        content: "おはようございます",
        created_at: chatSession.started_at,
      },
    ];
    vi.stubGlobal(
      "fetch",
      createRoutedFetchMock({
        sessions: [chatSession],
        sessionMessages: { 7: chatMessages },
      }),
    );

    render(<AppLayout />);
    // Let the dashboard's (default view's) own mount fetches settle first,
    // so their later state updates don't land outside act() once the test
    // has moved on to the chat/tasks views below.
    await waitFor(() =>
      expect(
        within(screen.getByRole("complementary", { name: "サイドパネル" })).getByText(
          "0 / 0 件完了（0%）",
        ),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "チャット" }));
    await waitFor(() =>
      expect(screen.getByText("おはようございます")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    await waitFor(() =>
      expect(screen.getByRole("main", { name: "タスクボード" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("おはようございます")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "チャット" }));
    await waitFor(() =>
      expect(screen.getByText("おはようございます")).toBeInTheDocument(),
    );
  });

  it("switches the main area to the settings view when the settings nav item is clicked", () => {
    render(<AppLayout />);

    const settingsButton = screen.getByRole("button", { name: "設定" });
    expect(settingsButton).toBeEnabled();

    fireEvent.click(settingsButton);

    expect(screen.getByRole("main", { name: "設定" })).toBeInTheDocument();
    expect(
      screen.queryByRole("main", { name: "ボスとの対話" }),
    ).not.toBeInTheDocument();
  });
});
