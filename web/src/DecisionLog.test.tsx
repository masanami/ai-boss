import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import DecisionLog from "./DecisionLog";
import { decisionSectionId } from "./decision-section-id";
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

// Issue #557 (S2a, 親 #438 決定15): タスク別セクションの id と、タスクカードの
// 導線から開いたときのプログラム的スクロール。`AppLayout` からの配線（state
// のセットとクリア）は AppLayout.test.tsx が持つため、ここでは対象タスク id と
// 消費コールバックを直接 props で与える。
describe("DecisionLog section ids and scroll target (Issue #557, S2a)", () => {
  // jsdom は `scrollIntoView` を実装しないので、呼び出しはプロトタイプ側へ
  // スタブを差して観測する（ChatView.test.tsx の `scrollHeight` と同じ作法）。
  // 元々 own property が無いので、後片付けは「消す」で元の状態に戻る。
  let scrolledElements: Element[] = [];

  function stubScrollIntoView(): void {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: function scrollIntoView(this: Element) {
        scrolledElements.push(this);
      },
    });
  }

  beforeEach(() => {
    scrolledElements = [];
  });

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  const RECORDS = [
    makeDecision({
      id: 1,
      task_id: 5,
      task_title: "見積もり資料の作成",
      created_at: at(9, 5, 9),
    }),
    makeDecision({
      id: 2,
      task_id: 8,
      task_title: "打ち合わせの準備",
      created_at: at(9, 5, 10),
    }),
    makeDecision({ id: 3, task_id: null, created_at: at(9, 5, 11) }),
  ];

  function sectionOf(title: string): HTMLElement {
    const section = screen
      .getByRole("heading", { level: 3, name: title })
      .closest("section");
    expect(section).not.toBeNull();
    return section as HTMLElement;
  }

  it("gives each task section an id derived from its task id", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(sectionOf("見積もり資料の作成")).toHaveAttribute(
        "id",
        decisionSectionId(5),
      ),
    );
    expect(sectionOf("打ち合わせの準備")).toHaveAttribute(
      "id",
      decisionSectionId(8),
    );
    // タスク id 由来であること自体を固定する（ヘルパーの中身が決定 id や連番に
    // すり替わっても、上の自己参照的な比較だけでは気づけないため）。
    expect(decisionSectionId(5)).toBe("decision-section-task-5");
    expect(decisionSectionId(8)).toBe("decision-section-task-8");
  });

  it("gives the section for records without a task_id a fixed id too", async () => {
    stubFetchWith(RECORDS);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(sectionOf("タスクに紐づかない決定")).toHaveAttribute(
        "id",
        decisionSectionId(null),
      ),
    );
    expect(decisionSectionId(null)).toBe("decision-section-unassigned");
    expect(document.querySelectorAll("section[id]")).toHaveLength(3);
    expect(
      new Set(
        Array.from(document.querySelectorAll("section[id]"), (el) => el.id),
      ).size,
    ).toBe(3);
  });

  it("scrolls the target task's section into view once the log has loaded, then reports the target as consumed", async () => {
    stubScrollIntoView();
    stubFetchWith(RECORDS);
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={5}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    await waitFor(() => expect(onScrollTargetConsumed).toHaveBeenCalled());
    // `toBe`（同一性）で比べる: `toEqual` は DOM ノードを構造等価で比較する
    // ので、似たマークアップの別セクションへ寄せても通ってしまう。
    expect(scrolledElements).toHaveLength(1);
    expect(scrolledElements[0]).toBe(sectionOf("見積もり資料の作成"));
  });

  it("does not scroll or report anything while the log is still loading", () => {
    stubScrollIntoView();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={5}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    expect(screen.getByText("決定ログを読み込み中…")).toBeInTheDocument();
    expect(onScrollTargetConsumed).not.toHaveBeenCalled();
    expect(scrolledElements).toEqual([]);
  });

  // 決定15: 消費は「スクロールした場合」に限らない。条件を分岐させると、
  // 漏れた経路に古い対象が残って次にナビゲーションから開いたときに動く。
  it("reports the target as consumed without scrolling when the task has no records", async () => {
    stubScrollIntoView();
    stubFetchWith(RECORDS);
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={999}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    await waitFor(() => expect(onScrollTargetConsumed).toHaveBeenCalled());
    expect(scrolledElements).toEqual([]);
    // 空セクションを作ったりエラーにしたりせず、いつもの一覧が出るだけ。
    expect(sectionTitles()).toEqual([
      "打ち合わせの準備",
      "見積もり資料の作成",
      "タスクに紐づかない決定",
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports the target as consumed when the log is empty", async () => {
    stubScrollIntoView();
    stubFetchWith([]);
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={5}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    await waitFor(() => expect(onScrollTargetConsumed).toHaveBeenCalled());
    expect(scrolledElements).toEqual([]);
    expect(screen.getByText("決定はまだありません")).toBeInTheDocument();
  });

  it("reports the target as consumed when the fetch fails", async () => {
    stubScrollIntoView();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={5}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    await waitFor(() => expect(onScrollTargetConsumed).toHaveBeenCalled());
    expect(scrolledElements).toEqual([]);
  });

  it("does not throw, and still reports the target as consumed, where scrollIntoView does not exist", async () => {
    // スタブを差さない＝ jsdom の素の状態。前提が崩れたら（jsdom が実装したら）
    // このテストは何も確かめなくなるので、前提そのものも固定する。
    expect(
      (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView,
    ).toBeUndefined();
    stubFetchWith(RECORDS);
    const onScrollTargetConsumed = vi.fn();

    render(
      <DecisionLog
        scrollTargetTaskId={5}
        onScrollTargetConsumed={onScrollTargetConsumed}
      />,
    );

    await waitFor(() => expect(onScrollTargetConsumed).toHaveBeenCalled());
    expect(sectionOf("見積もり資料の作成")).toBeInTheDocument();
  });

  it.each([undefined, null])(
    "never scrolls when no target is given (scrollTargetTaskId = %s)",
    async (scrollTargetTaskId) => {
      stubScrollIntoView();
      stubFetchWith(RECORDS);
      const onScrollTargetConsumed = vi.fn();

      render(
        <DecisionLog
          scrollTargetTaskId={scrollTargetTaskId}
          onScrollTargetConsumed={onScrollTargetConsumed}
        />,
      );

      await waitFor(() =>
        expect(sectionOf("見積もり資料の作成")).toBeInTheDocument(),
      );
      expect(scrolledElements).toEqual([]);
      expect(onScrollTargetConsumed).not.toHaveBeenCalled();
    },
  );

  it("renders the same headings, order and record content whether or not a target is given", async () => {
    stubScrollIntoView();
    stubFetchWith(RECORDS);
    const plain = render(<DecisionLog />);
    await waitFor(() =>
      expect(sectionOf("見積もり資料の作成")).toBeInTheDocument(),
    );
    const plainHtml = plain.container.innerHTML;
    expect(sectionTitles()).toEqual([
      "打ち合わせの準備",
      "見積もり資料の作成",
      "タスクに紐づかない決定",
    ]);
    plain.unmount();

    const targeted = render(
      <DecisionLog scrollTargetTaskId={5} onScrollTargetConsumed={vi.fn()} />,
    );
    await waitFor(() => expect(scrolledElements).toHaveLength(1));

    expect(targeted.container.innerHTML).toBe(plainHtml);
  });
});
