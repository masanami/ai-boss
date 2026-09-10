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
import { SIDE_PANEL_WIDTH_STORAGE_KEY } from "./side-panel-width";
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
    evidence_required: false,
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
  /**
   * Issue #470: called when a chat message is POSTed (including the session
   * lazily created by a task-origin mentoring send, since no session exists
   * in `sessions` yet). Returns the boss reply persisted for the turn;
   * defaults to a fixed reply when omitted.
   */
  onSendMessage?: (
    sessionId: number,
    body: { content: string; mentoring?: true; mentoringTaskId?: number },
  ) => ChatMessage;
  /**
   * Issue #470 (AC-2 regression coverage): when true, `GET /api/sessions`
   * never resolves, so `chatState.status` stays `"loading"` indefinitely —
   * simulating the window before useChat's mount restore settles.
   */
  sessionsPending?: boolean;
} = {}) {
  const {
    tasks: initialTasks = [],
    onCreateTask,
    onPatchTask,
    onCheckin,
    sessions = [],
    sessionMessages = {},
    onSendMessage,
    sessionsPending = false,
  } = options;
  let tasks = initialTasks;
  let nextCreatedSessionId = 1000;

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
      if (sessionsPending) {
        return new Promise(() => {});
      }
      return jsonResponse(200, sessions);
    }
    // Issue #470: a task-origin mentoring send lazily creates an adhoc
    // session (`useChat.send`'s existing behavior) when none is active yet.
    if (url === "/api/sessions" && method === "POST") {
      const body = JSON.parse(init?.body as string) as { type: string };
      const created: ChatSession = {
        id: nextCreatedSessionId++,
        type: body.type as ChatSession["type"],
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      };
      return jsonResponse(201, created);
    }
    const messagesMatch = /^\/api\/sessions\/(\d+)\/messages$/.exec(url);
    if (messagesMatch && method === "GET") {
      return jsonResponse(200, sessionMessages[Number(messagesMatch[1])] ?? []);
    }
    if (messagesMatch && method === "POST") {
      const sessionId = Number(messagesMatch[1]);
      const body = JSON.parse(init?.body as string) as {
        content: string;
        mentoring?: true;
        mentoringTaskId?: number;
      };
      const bossReply: ChatMessage = onSendMessage
        ? onSendMessage(sessionId, body)
        : {
            id: 900,
            session_id: sessionId,
            role: "boss",
            content: "了解した。",
            interrupted: 0,
            created_at: new Date().toISOString(),
          };
      const encoder = new TextEncoder();
      return Promise.resolve({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify(bossReply)}\n\n`,
              ),
            );
            controller.close();
          },
        }),
      });
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
  it("renders the seven nav items", () => {
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
    expect(
      screen.getByRole("button", { name: "作業ログ" }),
    ).toBeInTheDocument();
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

  it("switches the main area to the work log view when the work log nav item is clicked", () => {
    // 既定の（解決しない）fetch スタブのままでよい: main のラベル切り替えだけを
    // 確認する（日報・決定ログの既存スイッチテストと同じ作法）。
    render(<AppLayout />);

    fireEvent.click(screen.getByRole("button", { name: "作業ログ" }));

    expect(screen.getByRole("main", { name: "作業ログ" })).toBeInTheDocument();
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
        interrupted: 0,
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

  it("keeps the chat draft across a chat -> tasks -> chat round trip (Issue #153)", async () => {
    // The draft is lifted up to useChat (Issue #153) the same way the
    // conversation itself was (Issue #93), so leaving the chat tab
    // (unmounting ChatView) and coming back must not lose what was typed but
    // not yet sent. This exercises the real AppLayout wiring, not a
    // synthetic stand-in for it.
    vi.stubGlobal("fetch", createRoutedFetchMock());

    render(<AppLayout />);
    await waitFor(() =>
      expect(
        within(screen.getByRole("complementary", { name: "サイドパネル" })).getByText(
          "0 / 0 件完了（0%）",
        ),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "チャット" }));
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "書きかけの相談" },
    });

    fireEvent.click(screen.getByRole("button", { name: "タスク" }));
    await waitFor(() =>
      expect(screen.getByRole("main", { name: "タスクボード" })).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("メッセージ")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "チャット" }));
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toHaveValue("書きかけの相談"),
    );
  });

  // Issue #470 (親 #444): タスクカードからのメンタリング起動。判断
  // （adhoc 区間かどうか）は AppLayout が持ち、TaskBoard/TaskCard はそのまま
  // 配線するだけ（AC-1〜AC-4, AC-8, AC-9 の統合確認。単位レベルの確認は
  // TaskCard.test.tsx / TaskBoard.test.tsx / use-chat.test.ts /
  // chat-api.test.ts 側に持つ）。
  describe("タスクカードからのメンタリング起動 (Issue #470)", () => {
    it("shows a メンタリングする button on a task card during the adhoc period (AC-1)", async () => {
      const task = makeTask({ id: 1, title: "資料を作る", status: "todo" });
      vi.stubGlobal("fetch", createRoutedFetchMock({ tasks: [task] }));

      render(<AppLayout />);
      fireEvent.click(screen.getByRole("button", { name: "タスク" }));

      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "未着手" }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.getByRole("button", { name: "メンタリングする" }),
      ).toBeInTheDocument();
    });

    // 変異確認の対になるテスト（AC-1 側と対）: 表示条件を「常に表示」に
    // 壊すとこちらが落ち、「常に非表示」に壊すと AC-1 側が落ちる。
    it("does not show a メンタリングする button on a task card during a meeting (AC-2)", async () => {
      const task = makeTask({ id: 1, title: "資料を作る", status: "todo" });
      const morningSession: ChatSession = {
        id: 20,
        type: "morning",
        started_at: new Date().toISOString(),
        ended_at: null,
        summary: null,
      };
      vi.stubGlobal(
        "fetch",
        createRoutedFetchMock({ tasks: [task], sessions: [morningSession] }),
      );

      render(<AppLayout />);
      fireEvent.click(screen.getByRole("button", { name: "タスク" }));

      const todoColumn = await screen.findByRole("region", { name: "未着手" });
      await waitFor(() =>
        expect(within(todoColumn).getByText("資料を作る")).toBeInTheDocument(),
      );
      // sessionType が morning に確定する（chatState のマウント時取得と
      // tasksState のそれは並行するため、どちらが先に片付くかに依存しない
      // よう waitFor で待つ）。
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "メンタリングする" }),
        ).not.toBeInTheDocument(),
      );
    });

    // レビュー指摘 (code-reviewer/design-reviewer, self-review 1周目):
    // sessionType の初期値は "adhoc"（use-chat.ts）なので、chatState の
    // マウント時復元（会が開いているかどうかの判定）が解決する前の一瞬は、
    // 実際には会（朝会・夕会）の最中でもボタンが表示されてしまう窓がある。
    // `chatState.status === "ready"` も併せてゲートすることで閉じる。
    it("does not show a メンタリングする button while the chat session restore has not settled yet (AC-2, pre-restore window)", async () => {
      const task = makeTask({ id: 1, title: "資料を作る", status: "todo" });
      vi.stubGlobal(
        "fetch",
        createRoutedFetchMock({ tasks: [task], sessionsPending: true }),
      );

      render(<AppLayout />);
      fireEvent.click(screen.getByRole("button", { name: "タスク" }));

      // TaskBoard は tasksState に関わらず COLUMNS（空の region）を即座に
      // 描画するため、region の存在だけではタスクカードがまだ描画されて
      // いないことがある（self-review 2周目指摘）。カード自体の描画を
      // 待ってから不在を主張しないと、ボタンが無いのが「まだカードが無い
      // から」なのか「fix が効いているから」なのか区別が付かず、この
      // アサーションはゲート条件を元に戻しても恒真になりうる。
      const todoColumn = await screen.findByRole("region", { name: "未着手" });
      await waitFor(() =>
        expect(within(todoColumn).getByText("資料を作る")).toBeInTheDocument(),
      );
      // タスクカードは描画済みだが chat のセッション復元は永久に pending
      // （sessionsPending）— この状態が続く限りボタンは出ない。
      expect(
        screen.queryByRole("button", { name: "メンタリングする" }),
      ).not.toBeInTheDocument();
    });

    it("switches to chat and sends a message containing the task title, with mentoring: true and the matching mentoringTaskId, when メンタリングする is clicked (AC-3, AC-4, AC-8, AC-9)", async () => {
      const task = makeTask({ id: 42, title: "資料を作る", status: "todo" });
      let sentCount = 0;
      let sentBody: {
        content: string;
        mentoring?: true;
        mentoringTaskId?: number;
      } | null = null;
      vi.stubGlobal(
        "fetch",
        createRoutedFetchMock({
          tasks: [task],
          onSendMessage: (sessionId, body) => {
            sentCount += 1;
            sentBody = body;
            return {
              id: 900,
              session_id: sessionId,
              role: "boss",
              content: "見といた。",
              interrupted: 0,
              created_at: new Date().toISOString(),
            };
          },
        }),
      );

      render(<AppLayout />);
      fireEvent.click(screen.getByRole("button", { name: "タスク" }));
      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "未着手" }),
        ).toBeInTheDocument(),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "メンタリングする" }),
      );

      await waitFor(() =>
        expect(
          screen.getByRole("main", { name: "ボスとの対話" }),
        ).toBeInTheDocument(),
      );
      await waitFor(() => expect(sentBody).not.toBeNull());
      expect(sentCount).toBe(1);
      expect(sentBody).toEqual({
        content: "「資料を作る」の進め方を見てほしい",
        mentoring: true,
        mentoringTaskId: 42,
      });
    });
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

// jsdom's default window.innerWidth is 1024, giving an effective max of
// 1024 - NAV_WIDTH(200) - SPLITTER_WIDTH(6) - MAIN_MIN_WIDTH(480) = 338
// (below SIDE_PANEL_MAX_WIDTH's 420). Verified directly against
// window.innerWidth in this suite (see below) rather than assumed.
const DEFAULT_JSDOM_EFFECTIVE_MAX = 338;

function setWindowInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

describe("AppLayout side panel splitter (Issue #362)", () => {
  afterEach(() => {
    // vi.restoreAllMocks() here (rather than only at the end of the two
    // tests that spy on Storage.prototype) so a thrown/failed assertion
    // inside those tests can't skip the restore and leak the mock into
    // later tests in this describe block.
    vi.restoreAllMocks();
    localStorage.clear();
    setWindowInnerWidth(1024);
  });

  it("the test environment's default window width is 1024 (basis for DEFAULT_JSDOM_EFFECTIVE_MAX above)", () => {
    expect(window.innerWidth).toBe(1024);
  });

  it("renders exactly one separator, placed for the side panel (no nav-width control exists)", () => {
    render(<AppLayout />);

    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders the splitter with the ARIA attributes the window splitter pattern requires", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    expect(splitter).toHaveAttribute("aria-orientation", "vertical");
    expect(splitter).toHaveAttribute("aria-valuenow", "280");
    expect(splitter).toHaveAttribute("aria-valuemin", "280");
    expect(splitter).toHaveAttribute(
      "aria-valuemax",
      String(DEFAULT_JSDOM_EFFECTIVE_MAX),
    );
    expect(splitter).toHaveAttribute("tabindex", "0");
  });

  it("reflects the current width as the --side-panel-width custom property on .app-body", () => {
    const { container } = render(<AppLayout />);

    const appBody = container.querySelector(".app-body") as HTMLElement;
    expect(appBody.style.getPropertyValue("--side-panel-width")).toBe(
      "280px",
    );
  });

  it("widens the side panel by 16px when ArrowLeft is pressed on the focused splitter", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });

    expect(splitter).toHaveAttribute("aria-valuenow", "296");
  });

  it("narrows the side panel by 16px when ArrowRight is pressed on the focused splitter", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    // Widen first so the subsequent narrowing isn't masked by the floor clamp.
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    expect(splitter).toHaveAttribute("aria-valuenow", "280");
  });

  it("does not narrow past the floor (280) when ArrowRight is pressed while already at the floor", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "ArrowRight" });

    expect(splitter).toHaveAttribute("aria-valuenow", "280");
  });

  it("jumps to the floor (280) when Home is pressed", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    fireEvent.keyDown(splitter, { key: "Home" });

    expect(splitter).toHaveAttribute("aria-valuenow", "280");
  });

  it("jumps to the effective max when End is pressed", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "End" });

    expect(splitter).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_JSDOM_EFFECTIVE_MAX),
    );
  });

  it("does not widen past the effective max when ArrowLeft is pressed while already at the max", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "End" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });

    expect(splitter).toHaveAttribute(
      "aria-valuenow",
      String(DEFAULT_JSDOM_EFFECTIVE_MAX),
    );
  });

  it("persists a keyboard-driven width change to localStorage", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });

    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("296");
  });

  it("restores a previously saved width on mount", () => {
    // 300 is within [280, 338] (338 = DEFAULT_JSDOM_EFFECTIVE_MAX), so no
    // clamping should kick in and mask whether the stored value was read.
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "300");

    render(<AppLayout />);

    expect(
      screen.getByRole("separator", { name: "サイドパネルの幅" }),
    ).toHaveAttribute("aria-valuenow", "300");
  });

  it("falls back to the default width (280) when no value is stored", () => {
    render(<AppLayout />);

    expect(
      screen.getByRole("separator", { name: "サイドパネルの幅" }),
    ).toHaveAttribute("aria-valuenow", "280");
  });

  it("falls back to the default width (280) when the stored value is not numeric", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "not-a-number");

    render(<AppLayout />);

    expect(
      screen.getByRole("separator", { name: "サイドパネルの幅" }),
    ).toHaveAttribute("aria-valuenow", "280");
  });

  it("clamps an out-of-range stored value instead of discarding it", () => {
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "9999");

    render(<AppLayout />);

    expect(
      screen.getByRole("separator", { name: "サイドパネルの幅" }),
    ).toHaveAttribute("aria-valuenow", String(DEFAULT_JSDOM_EFFECTIVE_MAX));
  });

  it("falls back to the default width (280) without crashing when reading localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    render(<AppLayout />);

    expect(
      screen.getByRole("separator", { name: "サイドパネルの幅" }),
    ).toHaveAttribute("aria-valuenow", "280");
  });

  it("still applies a requested width change even when writing to localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });

    expect(splitter).toHaveAttribute("aria-valuenow", "296");
  });

  it("re-clamps the displayed width (without persisting) when the window shrinks below the current width's effective max", () => {
    // W=1200: effective max = 1200 - 200 - 6 - 480 = 514 -> capped at 420, so
    // the stored 420 mounts unclamped.
    setWindowInnerWidth(1200);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    expect(splitter).toHaveAttribute("aria-valuenow", "420");

    // W=1000: effective max = 1000 - 200 - 6 - 480 = 314.
    setWindowInnerWidth(1000);
    fireEvent(window, new Event("resize"));

    expect(splitter).toHaveAttribute("aria-valuenow", "314");
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("420");
  });

  it("recovers the saved preferred width once the window widens back out (resize does not overwrite the preference)", () => {
    setWindowInnerWidth(1200);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    setWindowInnerWidth(1000);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "314");

    setWindowInnerWidth(1200);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "420");
  });

  it("does not corrupt the saved preference when a keypress has no visible effect because the window is temporarily too narrow (code review regression test)", () => {
    // This is the scenario a code review caught before merge: pressing
    // ArrowLeft while already pinned at the window's effective max is a
    // no-op for the *display* (still clamped to the same ceiling), but an
    // earlier implementation persisted that clamped value anyway --
    // silently overwriting the saved 420 preference with the narrower 314,
    // so widening back out afterwards no longer recovered 420.
    setWindowInnerWidth(1200);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    // W=1000: effective max = 1000 - 200 - 6 - 480 = 314. Displayed width is
    // already pinned there by the resize; ArrowLeft (+16) has no visible
    // effect since 314+16=330 still clamps to 314.
    setWindowInnerWidth(1000);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "314");

    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(splitter).toHaveAttribute("aria-valuenow", "314");
    // The no-op keypress must not have touched the saved preference.
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("420");

    setWindowInnerWidth(1200);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "420");
  });

  it("persists the width the user asked for, not the window-clamped display value, when a widening keypress overshoots the window's ceiling", () => {
    // Complements the two "no visible effect" regression tests above, which
    // only pin the case where the display does NOT move. Here the display
    // *does* move (300 -> 314), so the persist guard lets the write through
    // -- and what gets written must be the requested 316, not the 314 the
    // window could actually show. Persisting the clamped display value
    // instead silently lowers the preference by the overshoot every time the
    // user widens against a temporary ceiling, and that loss only becomes
    // visible later, once the window is widened back out.
    //
    // Without this test, replacing clampToConfiguredBounds(requestedWidth)
    // with the already-clamped nextWidth in use-side-panel-width.ts's
    // setWidth passes the entire suite -- i.e. nothing else pins the reason
    // clampToConfiguredBounds exists as a separate function.
    setWindowInnerWidth(1000);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "300");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    // W=1000: effective max = 1000 - 200 - 6 - 480 = 314, so the stored 300
    // displays as-is and ArrowLeft (+16) requests 316 -- past the ceiling.
    expect(splitter).toHaveAttribute("aria-valuenow", "300");

    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(splitter).toHaveAttribute("aria-valuenow", "314");
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("316");

    setWindowInnerWidth(1200);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "316");
  });

  it("does not corrupt the saved preference when End is pressed while already at the effective max (second review round regression test)", () => {
    // Same class of bug as the ArrowLeft test above, caught in a second
    // review round: End requests the *window-derived* effective max, which
    // is itself a no-op when the display is already pinned there -- an
    // implementation that persisted it anyway would silently overwrite a
    // higher saved preference with the narrower ceiling.
    setWindowInnerWidth(1200);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    setWindowInnerWidth(1000);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "314");

    fireEvent.keyDown(splitter, { key: "End" });
    expect(splitter).toHaveAttribute("aria-valuenow", "314");
    expect(localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY)).toBe("420");

    setWindowInnerWidth(1200);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "420");
  });

  it("narrows immediately on every ArrowRight press with no dead zone, even when the preference exceeds the window's effective max (second review round regression test)", () => {
    // A naive fix for the two regression tests above (basing the keyboard
    // delta on the *preference* instead of the displayed width) breaks this
    // case: at W=1000 (effective max 314) with a 420 preference, several
    // ArrowRight presses would have no visible effect until the in-memory
    // preference itself dropped below 314 -- violating "-> narrows by
    // 16px" and the keyboard-operability requirement.
    setWindowInnerWidth(1200);
    localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, "420");
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    setWindowInnerWidth(1000);
    fireEvent(window, new Event("resize"));
    expect(splitter).toHaveAttribute("aria-valuenow", "314");

    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(splitter).toHaveAttribute("aria-valuenow", "298");
  });

  it("applies a pointer move's computed width while dragging (wiring, not real drag-follow -- jsdom has no PointerEvent/setPointerCapture)", () => {
    // jsdom can't simulate a real drag (no PointerEvent/setPointerCapture,
    // per the ticket's constraints), but the *wiring* from a pointermove
    // event to widthFromPointerX -> setWidth is plain React event handling
    // and is worth pinning down independently of that gap. The pointermove
    // handler gates on the isDraggingSplitter state (set by pointerdown),
    // not on hasPointerCapture, specifically so this is testable here.
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    fireEvent.pointerDown(splitter, { pointerId: 1 });
    // jsdom has no PointerEvent constructor at all (only pointerdown/up,
    // which this suite doesn't depend on clientX for, happen to still reach
    // the handler via fireEvent's fallback). A MouseEvent with type
    // "pointermove" still triggers the onPointerMove listener (DOM dispatch
    // matches by event *type* string, not constructor) and, unlike
    // fireEvent.pointerMove here, actually carries clientX.
    fireEvent(
      splitter,
      new MouseEvent("pointermove", { clientX: 724, bubbles: true }),
    );
    // windowWidth=1024 (jsdom default), clientX=724 -> requested 300px,
    // within [280, 338] (338 = DEFAULT_JSDOM_EFFECTIVE_MAX) so untouched by
    // clamping -- isolates the wiring from the clamp math already covered
    // elsewhere.
    expect(splitter).toHaveAttribute("aria-valuenow", "300");
  });

  it("ignores a pointer move that arrives without a preceding pointerdown on this splitter", () => {
    render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });

    fireEvent(
      splitter,
      new MouseEvent("pointermove", { clientX: 724, bubbles: true }),
    );

    expect(splitter).toHaveAttribute("aria-valuenow", "280");
  });

  it("wires aria-controls to the side panel's id (WAI-ARIA window splitter pattern)", () => {
    render(<AppLayout />);

    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    const sidePanel = screen.getByRole("complementary", {
      name: "サイドパネル",
    });
    expect(splitter).toHaveAttribute("aria-controls", sidePanel.id);
    expect(sidePanel.id).toBeTruthy();
  });

  it("suppresses text selection on .app-body only while the splitter is being dragged", () => {
    const { container } = render(<AppLayout />);
    const splitter = screen.getByRole("separator", { name: "サイドパネルの幅" });
    const appBody = container.querySelector(".app-body") as HTMLElement;
    expect(appBody).not.toHaveClass("app-body--dragging");

    fireEvent.pointerDown(splitter, { pointerId: 1 });
    expect(appBody).toHaveClass("app-body--dragging");

    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(appBody).not.toHaveClass("app-body--dragging");
  });
});
