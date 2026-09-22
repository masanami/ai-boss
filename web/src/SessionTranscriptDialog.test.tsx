import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import SessionTranscriptDialog from "./SessionTranscriptDialog";
import type { ChatMessage } from "./chat";

/** Local wall-clock timestamps so fixtures mean the same thing in any
 * timezone (ADR 0007 決定5). */
function at(hour: number, minute: number): string {
  return new Date(2026, 8, 22, hour, minute).toISOString();
}

function makeMessage(
  overrides: Partial<ChatMessage> & { id: number },
): ChatMessage {
  return {
    session_id: 7,
    role: "user",
    content: `message-${overrides.id}`,
    interrupted: 0,
    created_at: at(9, overrides.id),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

const RECORDED_AT = at(10, 30);

function renderDialog(
  overrides: Partial<Parameters<typeof SessionTranscriptDialog>[0]> = {},
) {
  const onClose = vi.fn();
  render(
    <SessionTranscriptDialog
      sessionId={7}
      sourceTitle="見積もり資料の作成"
      recordedAt={RECORDED_AT}
      taskReferenceTasks={null}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose };
}

describe("SessionTranscriptDialog (Issue #564, S3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET /api/sessions/:id/messages for the given session only", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<unknown>>(() =>
      jsonResponse(200, []),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog({ sessionId: 7 });

    await screen.findByText(/会話はありません/);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(["/api/sessions/7/messages"]);
  });

  it("shows the messages oldest first, with user and boss messages told apart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse(200, [
          makeMessage({ id: 1, role: "user", content: "進め方を見てほしい" }),
          makeMessage({ id: 2, role: "boss", content: "根拠を先に固めろ" }),
          makeMessage({ id: 3, role: "user", content: "わかった" }),
        ]),
      ),
    );

    renderDialog();

    const list = await screen.findByRole("list", { name: "会話の記録" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".chat-message-content")?.textContent)).toEqual([
      "進め方を見てほしい",
      "根拠を先に固めろ",
      "わかった",
    ]);
    expect(items.map((item) => item.querySelector(".chat-message-role")?.textContent)).toEqual([
      "自分",
      "ボス",
      "自分",
    ]);
    expect(items[0]).toHaveClass("chat-message-user");
    expect(items[1]).toHaveClass("chat-message-boss");
  });

  it("marks an interrupted boss reply the same way the chat does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse(200, [
          makeMessage({ id: 1, role: "boss", content: "途中", interrupted: 1 }),
        ]),
      ),
    );

    renderDialog();

    expect(await screen.findByText("ここで停止しました")).toBeInTheDocument();
  });

  it("has no input box, no send button and no form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse(200, [makeMessage({ id: 1, role: "boss", content: "よし" })]),
      ),
    );

    renderDialog();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("よし");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "送信" }),
    ).not.toBeInTheDocument();
    expect(dialog.querySelector("form, textarea, input")).toBeNull();
    // The only control is the close button.
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["閉じる"]);
  });

  it("shows where it was opened from: the source title and the record's date/time", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));

    renderDialog({ sourceTitle: "見積もり資料の作成", recordedAt: RECORDED_AT });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("見積もり資料の作成")).toBeInTheDocument();
    const time = dialog.querySelector(`time[datetime="${RECORDED_AT}"]`);
    expect(time).not.toBeNull();
    // RECORDED_AT is local 2026-09-22 10:30, so the rendered local time is
    // the same literal in every timezone.
    expect(time?.textContent).toBe("2026/9/22 10:30:00");
  });

  it("shows a loading state until the fetch settles", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );

    renderDialog();

    expect(screen.getByText("会話を読み込み中…")).toBeInTheDocument();
    resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await screen.findByText(/会話はありません/);
    expect(screen.queryByText("会話を読み込み中…")).not.toBeInTheDocument();
  });

  it("shows a session-not-found message on 404 session_not_found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse(404, {
          error: "session not found",
          code: "session_not_found",
        }),
      ),
    );

    renderDialog();

    expect(
      await screen.findByText("この会話のセッションが見つかりません"),
    ).toBeInTheDocument();
    expect(screen.queryByText("会話の取得に失敗しました")).not.toBeInTheDocument();
  });

  it.each([
    ["a 5xx response", () => jsonResponse(500, { error: "boom" })],
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("shows a generic fetch failure, distinct from 404, on %s", async (_label, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));

    renderDialog();

    expect(await screen.findByText("会話の取得に失敗しました")).toBeInTheDocument();
    expect(
      screen.queryByText("この会話のセッションが見つかりません"),
    ).not.toBeInTheDocument();
  });

  it("calls onClose when 閉じる is pressed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));

    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "閉じる" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("keyboard focus stays inside the dialog (PR #570 review)", () => {
    it.each([
      ["Tab", false],
      ["Shift+Tab", true],
    ])("keeps focus on the dialog's controls on %s from the close button", async (_label, shiftKey) => {
      vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));
      renderDialog();
      const close = await screen.findByRole("button", { name: "閉じる" });
      expect(close).toHaveFocus();

      // jsdom does not move focus on Tab by itself, so what is observable is
      // that the browser default (moving focus out) is cancelled and focus is
      // placed back inside the dialog.
      const notCancelled = fireEvent.keyDown(close, { key: "Tab", shiftKey });

      expect(notCancelled).toBe(false);
      expect(close).toHaveFocus();
    });

    it("wraps Shift+Tab from the dialog container itself back onto its controls", async () => {
      vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));
      renderDialog();
      const dialog = await screen.findByRole("dialog");
      dialog.focus();

      const notCancelled = fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });

      expect(notCancelled).toBe(false);
      expect(within(dialog).getByRole("button", { name: "閉じる" })).toHaveFocus();
    });

    it("pulls focus back into the dialog when it lands on an element behind it", async () => {
      vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));
      const outside = document.createElement("button");
      outside.textContent = "背面のナビ";
      document.body.appendChild(outside);
      try {
        renderDialog();
        const close = await screen.findByRole("button", { name: "閉じる" });

        outside.focus();

        expect(close).toHaveFocus();
      } finally {
        outside.remove();
      }
    });
  });

  it("calls onClose on Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(200, [])));

    const { onClose } = renderDialog();
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
