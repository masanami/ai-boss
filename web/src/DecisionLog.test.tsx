import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
