import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import DecisionLog from "./DecisionLog";
import type { DecisionRecord } from "./decision";

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
    created_at: "2026-07-05T00:00:00.000Z",
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

  it("renders the decision content, rationale, status badge, and related task", async () => {
    stubFetchWith([
      makeDecision({
        id: 1,
        content: "資料作成を最優先にする",
        rationale: "締切が近いため",
        status: "active",
        task_id: 42,
        task_title: "見積もり資料の作成",
      }),
    ]);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("資料作成を最優先にする")).toBeInTheDocument(),
    );
    expect(screen.getByText("根拠: 締切が近いため")).toBeInTheDocument();
    expect(screen.getByText("有効")).toBeInTheDocument();
    expect(screen.getByText("関連タスク: #42")).toBeInTheDocument();
  });

  it("renders multiple decisions with distinct status badges", async () => {
    stubFetchWith([
      makeDecision({ id: 1, content: "決定A", status: "active" }),
      makeDecision({ id: 2, content: "決定B", status: "revised" }),
      makeDecision({ id: 3, content: "決定C", status: "withdrawn" }),
    ]);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    expect(screen.getByText("決定B")).toBeInTheDocument();
    expect(screen.getByText("決定C")).toBeInTheDocument();
    expect(screen.getByText("有効")).toBeInTheDocument();
    expect(screen.getByText("修正済み")).toBeInTheDocument();
    expect(screen.getByText("取り下げ")).toBeInTheDocument();
  });

  it("shows no appeal affordances — the appeals feature was removed (#358/#397)", async () => {
    stubFetchWith([makeDecision({ id: 1, content: "決定A", status: "active" })]);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: "進言する" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("進言履歴")).not.toBeInTheDocument();
  });
});
