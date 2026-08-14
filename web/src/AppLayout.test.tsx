import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import AppLayout from "./AppLayout";
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
} = {}) {
  const { tasks = [], onCreateTask, onPatchTask } = options;

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
      return jsonResponse(
        201,
        onCreateTask(JSON.parse(init?.body as string) as unknown),
      );
    }
    const patchMatch = /^\/api\/tasks\/(\d+)$/.exec(url);
    if (patchMatch && method === "PATCH" && onPatchTask) {
      return jsonResponse(
        200,
        onPatchTask(
          Number(patchMatch[1]),
          JSON.parse(init?.body as string) as unknown,
        ),
      );
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
