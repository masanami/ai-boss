import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DecisionLog from "./DecisionLog";
import type { DecisionRecord } from "./decision";
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
    created_at: new Date(2026, 6, 5).toISOString(),
    updated_at: new Date(2026, 6, 5).toISOString(),
    completed_at: null,
    evidence_required: false,
    committed_start_at: null,
    committed_at: null,
    ...overrides,
  };
}

/** Builds a `created_at` from a local wall-clock date so ordering fixtures
 * stay meaningful in any timezone (ADR 0007 決定5). */
function at(month: number, day: number, hour: number): string {
  return new Date(2026, month - 1, day, hour).toISOString();
}

function makeDecision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 1,
    session_id: 1,
    task_id: null,
    task_title: null,
    content: "資料作成を最優先にする",
    rationale: "締切が近いため",
    status: "active",
    kind: "decision",
    created_at: at(9, 5, 9),
    ...overrides,
  };
}

function stubFetchWith(decisions: DecisionRecord[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(decisions),
    }),
  );
}

/** Section headings in render order. */
function sectionTitles(): string[] {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent ?? "");
}

describe("DecisionLog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty message when there are no decisions", async () => {
    stubFetchWith([]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("決定はまだありません")).toBeInTheDocument(),
    );
  });

  it("shows an alert when the initial fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "決定ログの取得に失敗しました",
      ),
    );
  });

  it("groups decisions with the same task under one section headed by the task name", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: 5,
        task_title: "見積もり資料の作成",
        content: "今日はこれを最優先で片付けろ",
      }),
      makeDecision({
        id: 2,
        task_id: 5,
        task_title: "見積もり資料の作成",
        content: "根拠を先に固めろ",
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("見積もり資料の作成")).toBeInTheDocument(),
    );
    expect(sectionTitles()).toEqual(["見積もり資料の作成"]);
    const section = screen.getByLabelText("見積もり資料の作成の記録");
    expect(
      within(section).getByText("今日はこれを最優先で片付けろ"),
    ).toBeInTheDocument();
    expect(within(section).getByText("根拠を先に固めろ")).toBeInTheDocument();
    // 生の task_id ではなくタスク名で辿れること
    expect(screen.queryByText("関連タスク: #5")).not.toBeInTheDocument();
  });

  it("orders task sections by their newest record and keeps the no-task section last", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: 5,
        task_title: "古いタスク",
        created_at: at(9, 1, 9),
      }),
      // 最新だが、タスクに紐づかないので末尾に置かれる
      makeDecision({ id: 2, task_id: null, created_at: at(9, 9, 9) }),
      makeDecision({
        id: 3,
        task_id: 7,
        task_title: "新しいタスク",
        created_at: at(9, 5, 9),
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("新しいタスク")).toBeInTheDocument(),
    );
    expect(sectionTitles()).toEqual([
      "新しいタスク",
      "古いタスク",
      "タスクに紐づかない決定",
    ]);
  });

  it("orders records within a section newest first", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: 5,
        task_title: "タスクA",
        content: "古い決定",
        created_at: at(9, 1, 9),
      }),
      makeDecision({
        id: 2,
        task_id: 5,
        task_title: "タスクA",
        content: "新しい決定",
        created_at: at(9, 6, 9),
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("タスクA")).toBeInTheDocument());
    const items = within(screen.getByLabelText("タスクAの記録")).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("新しい決定"),
      expect.stringContaining("古い決定"),
    ]);
  });

  it("interleaves mentoring records with decisions in the same task section, labelled by kind", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: 5,
        task_title: "見積もり資料の作成",
        kind: "decision",
        content: "今日はこれを最優先で片付けろ",
        created_at: at(9, 6, 9),
      }),
      makeDecision({
        id: 2,
        task_id: 5,
        task_title: "見積もり資料の作成",
        kind: "mentoring",
        content: "着手前に前提を確認していない",
        created_at: at(9, 6, 8),
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("見積もり資料の作成")).toBeInTheDocument(),
    );
    const section = screen.getByLabelText("見積もり資料の作成の記録");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("決定");
    expect(items[0].textContent).toContain("今日はこれを最優先で片付けろ");
    expect(items[1].textContent).toContain("メンタリング");
    expect(items[1].textContent).toContain("着手前に前提を確認していない");
  });

  it("shows the record content and rationale", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: null,
        content: "明日の朝会は 9:30 に変更する",
        rationale: "締切が明日のため",
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(
        screen.getByText("明日の朝会は 9:30 に変更する"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("根拠: 締切が明日のため")).toBeInTheDocument();
  });

  it("shows no status badge (status is now permanently active, so it was a no-op)", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: 5,
        task_title: "タスクA",
        status: "active",
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("タスクA")).toBeInTheDocument());
    expect(screen.queryByText("有効")).not.toBeInTheDocument();
    expect(screen.queryByText("修正済み")).not.toBeInTheDocument();
    expect(screen.queryByText("取り下げ")).not.toBeInTheDocument();
  });

  it("shows no appeal affordances — the appeals feature was removed (#358/#397)", async () => {
    stubFetchWith([makeDecision({ id: 1, task_id: 5, task_title: "タスクA" })]);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("タスクA")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "進言する" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("進言履歴")).not.toBeInTheDocument();
  });
});

// Issue #513 (S1, 決定1・決定2・決定3・決定4): 決定ログ本文中の `#<id>` に
// タスク名をホバー表示する。`AppLayout` からの配線は AppLayout.test.tsx が持つ
// ため、ここでは `tasks`/`tasksStatus` を直接 props で与える。
describe("DecisionLog task-id hover (Issue #513)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TASK_2 = makeTask({ id: 2, title: "打ち合わせの準備" });

  it("shows the task title as a hover (title attribute) on a #<id> in the decision content", async () => {
    stubFetchWith([
      makeDecision({ id: 1, task_id: null, content: "#2 を先に片付けろ" }),
    ]);

    const { container } = render(<DecisionLog tasks={[TASK_2]} tasksStatus="ready" />);

    // Waits on the container element itself, not `screen.getByText`: once
    // decorated, the content's text is split across a `<span>` and sibling
    // text nodes, and RTL's text matcher only inspects an element's *direct*
    // text-node children (not descendants), so a regex spanning the whole
    // sentence would never match the wrapping `<p>` here.
    await waitFor(() =>
      expect(container.querySelector(".decision-content")).not.toBeNull(),
    );
    const referenced = container.querySelector(".decision-content [title]");
    expect(referenced).not.toBeNull();
    expect(referenced).toHaveAttribute("title", "打ち合わせの準備");
    expect(referenced).toHaveTextContent("#2");
  });

  it("does not add a title-bearing element for a #<id> not in the task list", async () => {
    stubFetchWith([
      makeDecision({ id: 1, task_id: null, content: "#9999 は存在しない" }),
    ]);

    const { container } = render(<DecisionLog tasks={[TASK_2]} tasksStatus="ready" />);

    await waitFor(() =>
      expect(screen.getByText(/#9999 は存在しない/)).toBeInTheDocument(),
    );
    expect(container.querySelectorAll(".decision-content [title]")).toHaveLength(0);
  });

  it.each(["loading", "error"] as const)(
    "does not add a title-bearing element while the task list status is %s, even though a matching task exists",
    async (tasksStatus) => {
      stubFetchWith([
        makeDecision({ id: 1, task_id: null, content: "#2 を先に片付けろ" }),
      ]);

      const { container } = render(
        <DecisionLog tasks={[TASK_2]} tasksStatus={tasksStatus} />,
      );

      // 装飾されると本文が `<span>` とテキストノードに分かれ `getByText` が
      // 当たらなくなるので、本文要素そのものの出現を待つ（変異で装飾された
      // ときに「待ち合わせのタイムアウト」ではなく下のアサーションで落とす）。
      await waitFor(() =>
        expect(container.querySelector(".decision-content")).not.toBeNull(),
      );
      expect(
        container.querySelectorAll(".decision-content [title]"),
      ).toHaveLength(0);
      expect(container.querySelector(".decision-content")!.textContent).toBe(
        "#2 を先に片付けろ",
      );
    },
  );

  it("keeps the rendered textContent identical to the original content, decoration or not", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        task_id: null,
        content: "#2 と #9999 を同時に見てほしい",
      }),
    ]);

    const { container } = render(<DecisionLog tasks={[TASK_2]} tasksStatus="ready" />);

    // Same reason as above: wait on the DOM element itself, not a
    // `screen.getByText` regex spanning text split across the decorated
    // `<span>` and its sibling plain-text node.
    await waitFor(() =>
      expect(container.querySelector(".decision-content")).not.toBeNull(),
    );
    const content = container.querySelector(".decision-content");
    expect(content!.textContent).toBe("#2 と #9999 を同時に見てほしい");
  });
});

// Issue #689: タスクカードの「記録を見る」から開いたときは、そのタスクの節だけ
// に絞り込む。#557 のスクロールは実ブラウザでも動いていたが、記録 0 件の
// タスク（節が無い）・いちばん新しい節（もともと先頭）では何も動かず、最後の
// 節は先頭まで寄せられないため、「遷移しただけ」に見えた。絞り込みならどの
// 並びでも対象タスクの記録だけが目に入る。`AppLayout` からの配線（state の
// セットとクリア）は AppLayout.test.tsx が持つ。
describe("DecisionLog task filter (Issue #689)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const TARGET = { id: 5, title: "見積もり資料の作成" };
  const TARGET_DECISION = makeDecision({
    id: 1,
    task_id: 5,
    task_title: "見積もり資料の作成",
    content: "見積もりは金曜までに出す",
    created_at: at(9, 5, 9),
  });
  const TARGET_MENTORING = makeDecision({
    id: 4,
    task_id: 5,
    task_title: "見積もり資料の作成",
    kind: "mentoring",
    content: "先に前提を洗い出せ",
    created_at: at(9, 5, 12),
  });
  const OTHER_DECISION = makeDecision({
    id: 2,
    task_id: 8,
    task_title: "打ち合わせの準備",
    content: "議題は 3 つに絞る",
    created_at: at(9, 5, 10),
  });
  const UNASSIGNED_DECISION = makeDecision({
    id: 3,
    task_id: null,
    content: "明日の朝会は 9:30 に始める",
    created_at: at(9, 5, 11),
  });
  const RECORDS = [
    TARGET_DECISION,
    TARGET_MENTORING,
    OTHER_DECISION,
    UNASSIGNED_DECISION,
  ];

  it("shows only the target task's section — its decisions and mentoring records — when a filter is given", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(TARGET_DECISION.content)).toBeInTheDocument(),
    );
    expect(sectionTitles()).toEqual(["見積もり資料の作成"]);
    expect(screen.getByText(TARGET_MENTORING.content)).toBeInTheDocument();
    expect(screen.queryByText(OTHER_DECISION.content)).not.toBeInTheDocument();
    expect(
      screen.queryByText(UNASSIGNED_DECISION.content),
    ).not.toBeInTheDocument();
    // 並び（新しい順）は全体表示のときと変えない。
    const list = screen.getByRole("list", { name: "見積もり資料の作成の記録" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".decision-content")?.textContent),
    ).toEqual([TARGET_MENTORING.content, TARGET_DECISION.content]);
  });

  it("says which task the log is narrowed to", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    expect(
      await screen.findByText("「見積もり資料の作成」の記録だけを表示しています"),
    ).toBeInTheDocument();
  });

  it("says the task has no records yet instead of showing the whole log when it has none", async () => {
    stubFetchWith([OTHER_DECISION, UNASSIGNED_DECISION]);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    expect(
      await screen.findByText("このタスクの記録はまだありません"),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(screen.queryByText(OTHER_DECISION.content)).not.toBeInTheDocument();
    expect(screen.queryByText("決定はまだありません")).not.toBeInTheDocument();
  });

  it("says the task has no records yet when the log is entirely empty", async () => {
    stubFetchWith([]);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    expect(
      await screen.findByText("このタスクの記録はまだありません"),
    ).toBeInTheDocument();
    expect(screen.queryByText("決定はまだありません")).not.toBeInTheDocument();
  });

  // Issue #694: 絞り込みは支援技術にも伝える。押した「記録を見る」はカードごと
  // 消えるので、フォーカスを絞り込みの表示へ移して読み上げの起点にする。
  it("announces the narrowing as a status and moves focus to it", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(
      /^「見積もり資料の作成」の記録だけを表示しています$/,
    );
    expect(notice).toHaveFocus();
    expect(notice).toHaveAccessibleDescription("");
  });

  it("announces that the task has no records yet as a status too", async () => {
    stubFetchWith([OTHER_DECISION]);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    await screen.findByText("このタスクの記録はまだありません");
    expect(
      screen.getAllByRole("status").map((status) => status.textContent),
    ).toEqual([
      "「見積もり資料の作成」の記録だけを表示しています",
      "このタスクの記録はまだありません",
    ]);
    const notice = screen.getByText(
      "「見積もり資料の作成」の記録だけを表示しています",
    );
    expect(notice).toHaveFocus();
    // 表示と同時に挿入される status は読み上げられないことがあるので、
    // フォーカスした絞り込みの表示の説明としても読ませる。
    expect(notice).toHaveAccessibleDescription(
      "このタスクの記録はまだありません",
    );
  });

  it("does not take focus from where the user moved while the log was loading", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    render(
      <>
        <input aria-label="チャット入力" />
        <DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />
      </>,
    );
    const chatInput = screen.getByRole("textbox", { name: "チャット入力" });
    chatInput.focus();
    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve(RECORDS),
    });

    await screen.findByRole("status");
    expect(chatInput).toHaveFocus();
  });

  it("moves focus to the notice only once, not on every re-render", async () => {
    stubFetchWith(RECORDS);
    const onClearFilter = vi.fn();

    const { rerender } = render(
      <DecisionLog filterTask={TARGET} onClearFilter={onClearFilter} />,
    );
    const notice = await screen.findByRole("status");
    await waitFor(() => expect(notice).toHaveFocus());

    notice.blur();
    rerender(
      <DecisionLog filterTask={TARGET} onClearFilter={onClearFilter} />,
    );

    expect(document.activeElement).toBe(document.body);
  });

  it("neither adds a status nor moves focus when the log is not narrowed", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog />);

    await waitFor(() => expect(sectionTitles()).toHaveLength(3));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not turn the unfiltered empty message into a status", async () => {
    stubFetchWith([]);

    render(<DecisionLog />);

    await screen.findByText("決定はまだありません");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers a way back to the whole log, which calls onClearFilter", async () => {
    stubFetchWith(RECORDS);
    const onClearFilter = vi.fn();

    render(<DecisionLog filterTask={TARGET} onClearFilter={onClearFilter} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "すべての記録を表示" }),
    );
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it("offers the way back even when the task has no records", async () => {
    stubFetchWith([]);

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: "すべての記録を表示" }),
    ).toBeEnabled();
  });

  it.each([undefined, null])(
    "shows every section and no filter controls when no filter is given (filterTask = %s)",
    async (filterTask) => {
      stubFetchWith(RECORDS);

      render(<DecisionLog filterTask={filterTask} onClearFilter={vi.fn()} />);

      await waitFor(() =>
        expect(sectionTitles()).toEqual([
          "見積もり資料の作成",
          "打ち合わせの準備",
          "タスクに紐づかない決定",
        ]),
      );
      expect(
        screen.queryByRole("button", { name: "すべての記録を表示" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/だけを表示しています/)).not.toBeInTheDocument();
    },
  );

  it("still shows the loading state while the log is loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<DecisionLog filterTask={TARGET} onClearFilter={vi.fn()} />);

    expect(screen.getByText("決定ログを読み込み中…")).toBeInTheDocument();
  });
});

describe("DecisionLog mentoring record → session transcript (Issue #564, S3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const OPEN_LABEL = "会話を読み返す";

  const TASK_MENTORING = makeDecision({
    id: 1,
    session_id: 7,
    task_id: 5,
    task_title: "見積もり資料の作成",
    kind: "mentoring",
    content: "根拠を先に固めろ",
    rationale: "数字が弱い",
    created_at: at(9, 5, 10),
  });
  const OTHER_TASK_MENTORING = makeDecision({
    id: 2,
    session_id: 7,
    task_id: 8,
    task_title: "打ち合わせの準備",
    kind: "mentoring",
    content: "議題を3つに絞れ",
    rationale: null,
    created_at: at(9, 5, 11),
  });
  const UNASSIGNED_MENTORING = makeDecision({
    id: 3,
    session_id: 4,
    task_id: null,
    task_title: null,
    kind: "mentoring",
    content: "午前は集中作業にあてろ",
    rationale: null,
    created_at: at(9, 4, 9),
  });
  const TASK_DECISION = makeDecision({
    id: 4,
    session_id: 7,
    task_id: 5,
    task_title: "見積もり資料の作成",
    kind: "decision",
    content: "今日はこれを最優先で片付けろ",
    rationale: null,
    created_at: at(9, 5, 9),
  });
  const UNASSIGNED_DECISION = makeDecision({
    id: 5,
    session_id: 4,
    task_id: null,
    kind: "decision",
    content: "明日の朝会は9時半",
    rationale: null,
    created_at: at(9, 4, 8),
  });
  const RECORDS = [
    TASK_MENTORING,
    OTHER_TASK_MENTORING,
    UNASSIGNED_MENTORING,
    TASK_DECISION,
    UNASSIGNED_DECISION,
  ];

  function message(
    id: number,
    sessionId: number,
    role: "user" | "boss",
    content: string,
  ) {
    return {
      id,
      session_id: sessionId,
      role,
      content,
      interrupted: 0,
      created_at: new Date(2026, 8, 5, 9, id).toISOString(),
    };
  }

  const SESSION_MESSAGES: Record<number, unknown[]> = {
    7: [
      message(1, 7, "user", "見積もりの進め方を見てほしい"),
      message(2, 7, "boss", "根拠を先に固めろ"),
    ],
    4: [message(3, 4, "boss", "午前は集中作業にあてろ")],
  };

  /** Routes `/api/decisions` and `/api/sessions/:id/messages`; anything else
   * rejects so an unexpected call fails loudly. */
  function stubRoutedFetch(records: DecisionRecord[] = RECORDS) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const ok = (body: unknown) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        });
      if (url === "/api/decisions" && method === "GET") {
        return ok(records);
      }
      const match = /^\/api\/sessions\/(\d+)\/messages$/.exec(url);
      if (match && method === "GET") {
        return ok(SESSION_MESSAGES[Number(match[1])] ?? []);
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function cardOf(content: string): HTMLElement {
    const card = screen.getByText(content).closest("li");
    expect(card).not.toBeNull();
    return card as HTMLElement;
  }

  async function renderLoaded(): Promise<void> {
    render(<DecisionLog />);
    await screen.findByText("根拠を先に固めろ");
  }

  it("shows the transcript affordance on a mentoring record card", async () => {
    stubRoutedFetch();
    await renderLoaded();

    expect(
      within(cardOf("根拠を先に固めろ")).getByRole("button", { name: OPEN_LABEL }),
    ).toBeInTheDocument();
  });

  it("shows it on a mentoring record with no task_id too (「タスクに紐づかない決定」 section)", async () => {
    stubRoutedFetch();
    await renderLoaded();

    const section = screen.getByLabelText("タスクに紐づかない決定の記録");
    const card = within(section).getByText("午前は集中作業にあてろ").closest("li");
    expect(
      within(card as HTMLElement).getByRole("button", { name: OPEN_LABEL }),
    ).toBeInTheDocument();
  });

  it("does not show it on decision (kind='decision') record cards", async () => {
    stubRoutedFetch();
    await renderLoaded();

    for (const content of ["今日はこれを最優先で片付けろ", "明日の朝会は9時半"]) {
      expect(
        within(cardOf(content)).queryByRole("button", { name: OPEN_LABEL }),
      ).not.toBeInTheDocument();
    }
    // One per mentoring record, none for the decisions.
    expect(screen.getAllByRole("button", { name: OPEN_LABEL })).toHaveLength(3);
  });

  it("keeps the card's existing rendering (kind label, date, content, rationale) as it was", async () => {
    stubRoutedFetch();
    await renderLoaded();

    const card = cardOf("根拠を先に固めろ");
    const header = card.querySelector(".decision-card-header");
    expect(header?.outerHTML).toBe(
      '<div class="decision-card-header">' +
        '<span class="decision-kind decision-kind-mentoring">メンタリング</span>' +
        `<time datetime="${TASK_MENTORING.created_at}">${TASK_MENTORING.created_at}</time>` +
        "</div>",
    );
    expect(card.querySelector(".decision-content")?.textContent).toBe(
      "根拠を先に固めろ",
    );
    expect(card.querySelector(".decision-rationale")?.textContent).toBe(
      "根拠: 数字が弱い",
    );
    // The header / content / rationale still come first, in the same order.
    expect(
      Array.from(card.children)
        .slice(0, 3)
        .map((child) => child.className),
    ).toEqual(["decision-card-header", "decision-content", "decision-rationale"]);
  });

  it("keeps section headings, section order and record order unchanged", async () => {
    stubRoutedFetch();
    await renderLoaded();

    expect(sectionTitles()).toEqual([
      "打ち合わせの準備",
      "見積もり資料の作成",
      "タスクに紐づかない決定",
    ]);
    const taskItems = within(
      screen.getByLabelText("見積もり資料の作成の記録"),
    ).getAllByRole("listitem");
    expect(
      taskItems.map((item) => item.querySelector(".decision-content")?.textContent),
    ).toEqual(["根拠を先に固めろ", "今日はこれを最優先で片付けろ"]);
  });

  it("opens the transcript of that record's session_id (and no other) when pressed", async () => {
    const fetchMock = stubRoutedFetch();
    await renderLoaded();

    fireEvent.click(
      within(cardOf("午前は集中作業にあてろ")).getByRole("button", {
        name: OPEN_LABEL,
      }),
    );

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("午前は集中作業にあてろ");
    const messageUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/sessions"));
    expect(messageUrls).toEqual(["/api/sessions/4/messages"]);
  });

  it("shows the task title and the record's date/time when opened from a record with a task_id", async () => {
    stubRoutedFetch();
    await renderLoaded();

    fireEvent.click(
      within(cardOf("根拠を先に固めろ")).getByRole("button", { name: OPEN_LABEL }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "見積もり資料の作成" }),
    ).toBeInTheDocument();
    expect(
      dialog.querySelector(`time[datetime="${TASK_MENTORING.created_at}"]`),
    ).not.toBeNull();
  });

  it("shows UNASSIGNED_SECTION_TITLE when opened from a record with no task_id", async () => {
    stubRoutedFetch();
    await renderLoaded();

    fireEvent.click(
      within(cardOf("午前は集中作業にあてろ")).getByRole("button", {
        name: OPEN_LABEL,
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "タスクに紐づかない決定" }),
    ).toBeInTheDocument();
    expect(
      dialog.querySelector(`time[datetime="${UNASSIGNED_MENTORING.created_at}"]`),
    ).not.toBeNull();
  });

  it("shows the same #<task_id> fallback as the section heading when a record's task_title is missing", async () => {
    stubRoutedFetch([
      makeDecision({
        id: 9,
        session_id: 7,
        task_id: 12,
        task_title: null,
        kind: "mentoring",
        content: "根拠を先に固めろ",
      }),
    ]);
    await renderLoaded();

    expect(sectionTitles()).toEqual(["#12"]);
    fireEvent.click(
      within(cardOf("根拠を先に固めろ")).getByRole("button", { name: OPEN_LABEL }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "#12" })).toBeInTheDocument();
  });

  it("returns focus to the affordance it was opened from when closed", async () => {
    stubRoutedFetch();
    await renderLoaded();

    const opener = within(cardOf("根拠を先に固めろ")).getByRole("button", {
      name: OPEN_LABEL,
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "閉じる" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));

    expect(opener).toHaveFocus();
  });

  it("opens the same session from two mentoring records (different tasks) sharing a session_id, each showing its own origin", async () => {
    const fetchMock = stubRoutedFetch();
    await renderLoaded();

    fireEvent.click(
      within(cardOf("議題を3つに絞れ")).getByRole("button", { name: OPEN_LABEL }),
    );
    let dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("見積もりの進め方を見てほしい");
    expect(
      within(dialog).getByRole("heading", { name: "打ち合わせの準備" }),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));

    fireEvent.click(
      within(cardOf("根拠を先に固めろ")).getByRole("button", { name: OPEN_LABEL }),
    );
    dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("見積もりの進め方を見てほしい");
    expect(
      within(dialog).getByRole("heading", { name: "見積もり資料の作成" }),
    ).toBeInTheDocument();

    const messageUrls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/sessions"));
    expect(messageUrls).toEqual([
      "/api/sessions/7/messages",
      "/api/sessions/7/messages",
    ]);
  });

  it("returns to the decision log when the transcript is closed", async () => {
    stubRoutedFetch();
    await renderLoaded();

    fireEvent.click(
      within(cardOf("根拠を先に固めろ")).getByRole("button", { name: OPEN_LABEL }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sectionTitles()).toEqual([
      "打ち合わせの準備",
      "見積もり資料の作成",
      "タスクに紐づかない決定",
    ]);
    expect(screen.getAllByRole("button", { name: OPEN_LABEL })).toHaveLength(3);
  });
});
