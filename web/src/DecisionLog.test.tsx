import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DecisionLog from "./DecisionLog";
import type { DecisionWithAppeals } from "./decision";

function makeDecision(overrides: Partial<DecisionWithAppeals>): DecisionWithAppeals {
  return {
    id: 1,
    session_id: 1,
    task_id: null,
    content: "資料作成を最優先にする",
    rationale: "締切が近いため",
    status: "active",
    created_at: "2026-07-05T00:00:00.000Z",
    appeals: [],
    ...overrides,
  };
}

describe("DecisionLog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty message when there are no decisions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );

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
    const decisions = [
      makeDecision({
        id: 1,
        content: "資料作成を最優先にする",
        rationale: "締切が近いため",
        status: "active",
        task_id: 42,
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(decisions),
      }),
    );

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("資料作成を最優先にする")).toBeInTheDocument(),
    );
    expect(screen.getByText("根拠: 締切が近いため")).toBeInTheDocument();
    expect(screen.getByText("有効")).toBeInTheDocument();
    expect(screen.getByText("関連タスク: #42")).toBeInTheDocument();
  });

  it("renders multiple decisions with distinct status badges", async () => {
    const decisions = [
      makeDecision({ id: 1, content: "決定A", status: "active" }),
      makeDecision({ id: 2, content: "決定B", status: "revised" }),
      makeDecision({ id: 3, content: "決定C", status: "withdrawn" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(decisions),
      }),
    );

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    expect(screen.getByText("決定B")).toBeInTheDocument();
    expect(screen.getByText("決定C")).toBeInTheDocument();
    expect(screen.getByText("有効")).toBeInTheDocument();
    expect(screen.getByText("修正済み")).toBeInTheDocument();
    expect(screen.getByText("取り下げ")).toBeInTheDocument();
  });

  it("renders the appeal history for a decision (content, verdict, boss response)", async () => {
    const decisions = [
      makeDecision({
        id: 1,
        appeals: [
          {
            id: 10,
            decision_id: 1,
            content: "他を優先させてほしい",
            verdict: "upheld",
            response: "検討したが決定は維持する",
            created_at: "2026-07-05T01:00:00.000Z",
          },
        ],
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(decisions),
      }),
    );

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("進言: 他を優先させてほしい")).toBeInTheDocument(),
    );
    expect(screen.getByText("裁定: 維持")).toBeInTheDocument();
    expect(screen.getByText("検討したが決定は維持する")).toBeInTheDocument();
  });

  it("shows an appeal form only for active decisions", async () => {
    const decisions = [
      makeDecision({ id: 1, content: "決定A", status: "active" }),
      makeDecision({ id: 2, content: "決定B", status: "revised" }),
      makeDecision({ id: 3, content: "決定C", status: "withdrawn" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(decisions),
      }),
    );

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "進言する" })).toHaveLength(1);
  });

  it("submits an appeal and reflects an upheld verdict in the refreshed list", async () => {
    const original = makeDecision({ id: 1, content: "決定A", status: "active" });
    const refreshed = makeDecision({
      id: 1,
      content: "決定A",
      status: "active",
      appeals: [
        {
          id: 10,
          decision_id: 1,
          content: "他を優先させてほしい",
          verdict: "upheld",
          response: "検討したが決定は維持する",
          created_at: "2026-07-05T01:00:00.000Z",
        },
      ],
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([original]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          appeal: refreshed.appeals[0],
          decision: { ...original, appeals: undefined },
        }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([refreshed]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "進言する" }));
    fireEvent.change(screen.getByLabelText("進言内容"), {
      target: { value: "他を優先させてほしい" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByText("進言: 他を優先させてほしい")).toBeInTheDocument(),
    );
    expect(screen.getByText("裁定: 維持")).toBeInTheDocument();
    expect(screen.getByText("検討したが決定は維持する")).toBeInTheDocument();
  });

  it("submits an appeal and reflects a revised verdict (original marked revised, new decision added)", async () => {
    const original = makeDecision({ id: 1, content: "今日中に資料作成を終える", status: "active" });
    const revisedOriginal = { ...original, status: "revised" as const };
    const newDecision = makeDecision({
      id: 2,
      content: "明日までに資料作成を終える",
      status: "active",
      rationale: "進言の内容が妥当なため",
    });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([original]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          appeal: {
            id: 10,
            decision_id: 1,
            content: "今日は間に合わない",
            verdict: "revised",
            response: "検討の結果、修正する",
            created_at: "2026-07-05T01:00:00.000Z",
          },
          decision: { ...revisedOriginal, appeals: undefined },
          revisedDecision: { ...newDecision, appeals: undefined },
        }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          newDecision,
          {
            ...revisedOriginal,
            appeals: [
              {
                id: 10,
                decision_id: 1,
                content: "今日は間に合わない",
                verdict: "revised",
                response: "検討の結果、修正する",
                created_at: "2026-07-05T01:00:00.000Z",
              },
            ],
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("今日中に資料作成を終える")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "進言する" }));
    fireEvent.change(screen.getByLabelText("進言内容"), {
      target: { value: "今日は間に合わない" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(
        screen.getByText("明日までに資料作成を終える"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("修正済み")).toBeInTheDocument();
    expect(screen.getByText("裁定: 修正")).toBeInTheDocument();
    expect(screen.getByText("検討の結果、修正する")).toBeInTheDocument();
    // The now-revised decision no longer offers an appeal action.
    expect(screen.getAllByRole("button", { name: "進言する" })).toHaveLength(1);
  });

  it("shows an alert and keeps the form open when the appeal submission fails", async () => {
    const original = makeDecision({ id: 1, content: "決定A", status: "active" });
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([original]),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({ error: "decision 1 is not active (status: revised)" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionLog />);

    await waitFor(() => expect(screen.getByText("決定A")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "進言する" }));
    fireEvent.change(screen.getByLabelText("進言内容"), {
      target: { value: "進言する内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "decision 1 is not active (status: revised)",
      ),
    );
    // The form stays open with the draft intact so the user can retry.
    expect(screen.getByLabelText("進言内容")).toHaveValue("進言する内容");
  });

  it("does not call fetch again while the form is closed for a non-active decision", async () => {
    const decisions = [makeDecision({ id: 1, status: "revised" })];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(decisions),
      }),
    );

    render(<DecisionLog />);

    await waitFor(() =>
      expect(screen.getByText("資料作成を最優先にする")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "進言する" }),
    ).not.toBeInTheDocument();
  });
});
