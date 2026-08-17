import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ChatView from "./ChatView";
import { useChat, type UseChatResult } from "./use-chat";
import type { ChatMessage, ChatSession } from "./chat";

// ChatView no longer calls useChat itself (Issue #93: the hook is lifted up
// to AppLayout so the conversation survives a tab switch). This harness
// mirrors how AppLayout wires the two together, so the bulk of the existing
// fetch-driven scenarios below keep exercising the real hook + component
// integration unchanged.
//
// The Issue #153 regression test for "draft survives leaving/revisiting the
// chat tab" lives in AppLayout.test.tsx instead of here: it needs the real
// AppLayout conditional rendering (not a synthetic stand-in for it) to catch
// a regression if that wiring ever changes.
function ChatViewHarness() {
  const chatState = useChat();
  return <ChatView chatState={chatState} />;
}

const SESSION: ChatSession = {
  id: 1,
  type: "adhoc",
  started_at: "2026-07-05T09:00:00.000Z",
  ended_at: null,
  summary: null,
};

const HISTORY: ChatMessage[] = [
  {
    id: 1,
    session_id: 1,
    role: "user",
    content: "おはようございます",
    created_at: "2026-07-05T09:00:00.000Z",
  },
  {
    id: 2,
    session_id: 1,
    role: "boss",
    content: "今日は A 案件からだ。",
    created_at: "2026-07-05T09:00:05.000Z",
  },
];

const BOSS_REPLY: ChatMessage = {
  id: 3,
  session_id: 1,
  role: "boss",
  content: "B 案件は後回しにしろ。",
  created_at: "2026-07-05T10:00:00.000Z",
};

const MORNING_SESSION: ChatSession = {
  id: 20,
  type: "morning",
  started_at: "2026-07-05T00:00:00.000Z",
  ended_at: null,
  summary: null,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(body) };
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  };
}

beforeEach(() => {
  // Only `Date` is faked so React Testing Library's `waitFor` (real
  // `setTimeout` polling) keeps working. `SESSION.started_at` above is on
  // 2026-07-05, so "now" is fixed to the same local day (adhoc daily
  // cutoff).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-05T03:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeChatState(overrides: Partial<UseChatResult> = {}): UseChatResult {
  return {
    entries: [],
    status: "ready",
    sessionType: "adhoc",
    sending: false,
    switching: false,
    streamingText: "",
    error: null,
    draft: "",
    setDraft: vi.fn(),
    send: vi.fn(),
    startSession: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  };
}

describe("ChatView (rendering purely from the chatState prop)", () => {
  it("renders entries and the session badge from the given chatState, without calling fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatView
        chatState={makeChatState({
          sessionType: "morning",
          entries: [
            { kind: "message", key: "message-1", role: "user", content: "今日の予定です" },
          ],
        })}
      />,
    );

    expect(screen.getByText("今日の予定です")).toBeInTheDocument();
    expect(screen.getByText("朝会中")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ChatView", () => {
  it("shows a loading state while the history is being restored", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    render(<ChatViewHarness />);

    expect(screen.getByText("会話履歴を読み込み中…")).toBeInTheDocument();
  });

  it("renders the restored history with role labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse(HISTORY)),
    );

    render(<ChatViewHarness />);

    await waitFor(() =>
      expect(screen.getByText("おはようございます")).toBeInTheDocument(),
    );
    expect(screen.getByText("今日は A 案件からだ。")).toBeInTheDocument();
    expect(screen.getByText("自分")).toBeInTheDocument();
    expect(screen.getByText("ボス")).toBeInTheDocument();
  });

  it("shows an error state when the history restoration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    render(<ChatViewHarness />);

    await waitFor(() =>
      expect(
        screen.getByText("会話履歴の読み込みに失敗しました"),
      ).toBeInTheDocument(),
    );
  });

  it("sends the draft and renders the boss reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "相談があります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByText("B 案件は後回しにしろ。")).toBeInTheDocument(),
    );
    expect(screen.getByText("相談があります")).toBeInTheDocument();
    expect(screen.getByLabelText("メッセージ")).toHaveValue("");
  });

  it("renders the message input as a multi-line textarea", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    expect(screen.getByLabelText("メッセージ").tagName).toBe("TEXTAREA");
  });

  it("sends the draft when Enter is pressed without a modifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    const input = screen.getByLabelText("メッセージ");
    fireEvent.change(input, { target: { value: "相談があります" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByText("B 案件は後回しにしろ。")).toBeInTheDocument(),
    );
    expect(input).toHaveValue("");
  });

  it("does not send the draft when Shift+Enter is pressed (newline)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );
    fetchMock.mockClear();

    const input = screen.getByLabelText("メッセージ");
    fireEvent.change(input, { target: { value: "一行目" } });

    // jsdom は keydown の既定動作（textarea への改行挿入）を実行しないため、
    // 「送信されないこと」だけを見ると preventDefault する実装でも通ってしまう。
    // キャンセル可能なイベントを dispatch し、既定動作が妨げられていない
    // （＝ブラウザなら改行が挿入される）ことまで検証する。
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, shiftEnter);

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("一行目");
  });

  it("does not send the draft when Enter confirms an IME composition", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );
    fetchMock.mockClear();

    const input = screen.getByLabelText("メッセージ");
    fireEvent.change(input, { target: { value: "そうだん" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("そうだん");
  });

  it("does not send on Enter while the draft is whitespace only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );
    fetchMock.mockClear();

    const input = screen.getByLabelText("メッセージ");
    fireEvent.change(input, { target: { value: "   \n  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("keeps the newlines of a multi-line message when rendering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    const input = screen.getByLabelText("メッセージ");
    fireEvent.change(input, { target: { value: "一行目\n二行目" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The default text normalizer collapses the newline, so the raw
    // textContent is what proves it survived rendering (`white-space:
    // pre-wrap` in ChatView.css turns it into a visible line break).
    const bubble = await screen.findByText("一行目 二行目");
    expect(bubble).toHaveClass("chat-message-content");
    expect(bubble.textContent).toBe("一行目\n二行目");
  });

  it("disables the send button while the draft is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "送信" })).toBeInTheDocument(),
    );

    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "テスト" },
    });
    expect(screen.getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("disables the input and the send button while a message is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockImplementationOnce(() => new Promise(() => {})),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "相談があります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "送信中…" }),
      ).toBeDisabled(),
    );
    expect(screen.getByLabelText("メッセージ")).toBeDisabled();
  });

  it("renders a tool notice when the boss operates a task", async () => {
    const toolEvent = {
      name: "create_task",
      input: { title: "資料作成" },
      result: JSON.stringify({ id: 5, title: "資料作成" }),
      isError: false,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            `event: tool\ndata: ${JSON.stringify(toolEvent)}\n\n`,
            `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
          ]),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "タスク化して" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(
        screen.getByText("ボスがタスクを作成しました: 資料作成"),
      ).toBeInTheDocument(),
    );
  });

  it("shows an alert when the stream reports an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(
          sseResponse([
            'event: error\ndata: {"error":"ボスの応答中にエラーが発生しました"}\n\n',
          ]),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "テスト" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ボスの応答中にエラーが発生しました",
      ),
    );
  });

  it("shows the morning/evening start buttons while chatting adhoc", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    render(<ChatViewHarness />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "朝会を開始" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "夕会を開始" }),
    ).toBeInTheDocument();
  });

  it("starts a morning session and shows the in-session badge with an end button", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
        .mockResolvedValueOnce(jsonResponse([])) // no morning session today
        .mockResolvedValueOnce(jsonResponse(MORNING_SESSION, 201)), // create
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "朝会を開始" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "朝会を開始" }));

    await waitFor(() => expect(screen.getByText("朝会中")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "朝会を終了" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "朝会を開始" }),
    ).not.toBeInTheDocument();
  });

  it("ends a morning session and returns to the adhoc start buttons", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(MORNING_SESSION, 201))
        .mockResolvedValueOnce(
          jsonResponse({ ...MORNING_SESSION, ended_at: "2026-07-05T01:00:00.000Z" }),
        ),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "朝会を開始" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "朝会を開始" }));
    await waitFor(() => expect(screen.getByText("朝会中")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "朝会を終了" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "朝会を開始" }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "夕会を開始" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("朝会中")).not.toBeInTheDocument();
  });

  it("shows the evening badge when starting an evening session", async () => {
    const eveningSession: ChatSession = { ...MORNING_SESSION, id: 21, type: "evening" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse(eveningSession, 201)),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "夕会を開始" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "夕会を開始" }));

    await waitFor(() => expect(screen.getByText("夕会中")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: "夕会を終了" }),
    ).toBeInTheDocument();
  });

  it("disables the send button and message input while a session switch is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockImplementationOnce(() => new Promise(() => {})), // startSession's list lookup never resolves
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "朝会を開始" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "朝会を開始" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "朝会を開始" })).toBeDisabled(),
    );
    expect(screen.getByLabelText("メッセージ")).toBeDisabled();
    expect(screen.getByRole("button", { name: "送信" })).toBeDisabled();
  });

  it("disables the session start buttons while a message is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockImplementationOnce(() => new Promise(() => {})), // createSession("adhoc") never resolves
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "相談があります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "朝会を開始" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "夕会を開始" })).toBeDisabled();
  });
});

describe("ChatView auto-scroll (Issue #130)", () => {
  // jsdom always reports `scrollHeight` as 0, so the auto-scroll effect
  // (`el.scrollTop = el.scrollHeight`) can't be observed without stubbing
  // it. Stubbing on the prototype (rather than a single element instance)
  // means the getter is already in place before React mounts and runs the
  // effect for the first time, and `scrollTop` itself is a plain jsdom
  // property that reads back whatever was last set, so no separate stub is
  // needed for it.
  //
  // The getter only reports `scrollHeightValue` for `.chat-timeline`
  // itself; every other element (notably the auto-growing textarea, which
  // reads its own `scrollHeight` in a separate effect) keeps jsdom's
  // default of 0, so this stub can't leak into unrelated assertions.
  //
  // jsdom defines `scrollHeight` on `Element.prototype`, not
  // `HTMLElement.prototype`, so there is no own descriptor to save and
  // restore here; deleting the stubbed own property is enough to fall back
  // to the inherited implementation.
  let scrollHeightValue = 0;

  beforeEach(() => {
    scrollHeightValue = 800;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("chat-timeline") ? scrollHeightValue : 0;
      },
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
  });

  function timelineOf(container: HTMLElement): HTMLElement {
    const el = container.querySelector(".chat-timeline");
    if (el === null) {
      throw new Error(".chat-timeline not found");
    }
    return el as HTMLElement;
  }

  it("scrolls the timeline to the bottom once the history has rendered", () => {
    const { container } = render(
      <ChatView
        chatState={makeChatState({
          entries: [
            {
              kind: "message",
              key: "message-1",
              role: "user",
              content: "おはようございます",
            },
            {
              kind: "message",
              key: "message-2",
              role: "boss",
              content: "今日は A 案件からだ。",
            },
          ],
        })}
      />,
    );

    expect(timelineOf(container).scrollTop).toBe(800);
  });

  it("scrolls back to the bottom when a new entry is appended", () => {
    const { container, rerender } = render(
      <ChatView
        chatState={makeChatState({
          entries: [
            { kind: "message", key: "message-1", role: "user", content: "一件目" },
          ],
        })}
      />,
    );
    expect(timelineOf(container).scrollTop).toBe(800);

    scrollHeightValue = 1200;
    rerender(
      <ChatView
        chatState={makeChatState({
          entries: [
            { kind: "message", key: "message-1", role: "user", content: "一件目" },
            { kind: "message", key: "message-2", role: "boss", content: "二件目" },
          ],
        })}
      />,
    );

    expect(timelineOf(container).scrollTop).toBe(1200);
  });

  it("scrolls to the bottom as the streaming reply grows", () => {
    const baseEntries = [
      { kind: "message" as const, key: "message-1", role: "user" as const, content: "相談です" },
    ];
    const { container, rerender } = render(
      <ChatView chatState={makeChatState({ entries: baseEntries })} />,
    );
    expect(timelineOf(container).scrollTop).toBe(800);

    scrollHeightValue = 950;
    rerender(
      <ChatView
        chatState={makeChatState({
          entries: baseEntries,
          streamingText: "考え中",
        })}
      />,
    );
    expect(timelineOf(container).scrollTop).toBe(950);

    scrollHeightValue = 1100;
    rerender(
      <ChatView
        chatState={makeChatState({
          entries: baseEntries,
          streamingText: "考え中です…B 案件は後回しにしろ。",
        })}
      />,
    );
    expect(timelineOf(container).scrollTop).toBe(1100);
  });
});
