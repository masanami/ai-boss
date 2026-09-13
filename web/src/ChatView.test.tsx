import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ChatView from "./ChatView";
import { useChat, type UseChatResult } from "./use-chat";
import type { ChatEntry, ChatMessage, ChatSession } from "./chat";

// ChatView no longer calls useChat itself (Issue #93: the hook is lifted up
// to AppLayout so the conversation survives a tab switch). This harness
// mirrors how AppLayout wires the two together, so the bulk of the existing
// fetch-driven scenarios below keep exercising the real hook + component
// integration unchanged.
//
// The Issue #153 regression test for "draft survives leaving/revisiting the
// chat tab" lives in AppLayout.test.tsx instead of here: it needs the real
// AppLayout conditional rendering (not a synthetic stand-in for it) to catch
// a regression in that wiring. use-chat.test.ts separately covers the
// underlying hook-level contract that makes that possible — draft survives
// the hook's own startSession/endSession session switches (GAP-19) — but
// does not attempt to reproduce unmounting the consuming component itself: a
// hand-rolled toggle harness for that turned out to be unable to fail (draft
// lives in the *parent's* `useState`, so no `useChat` implementation could
// lose it there) and was removed as tautological (self-review finding).
function ChatViewHarness() {
  const chatState = useChat();
  return <ChatView chatState={chatState} />;
}

// Local-time anchors (ADR 0007 決定5). `select-restore-session.ts` decides
// whether a session is still "today's" via `isSameLocalDay`, which compares
// *local* calendar dates. Fixing these timestamps as UTC literals made the
// fixtures straddle two local days in negative-offset zones — under
// `TZ=America/New_York`, `started_at` 09:00Z landed on 07-05 while a faked
// "now" of 03:00Z landed on 07-04, so the session was treated as stale and
// the history never restored (Issue #177). Deriving every calendar-relevant
// timestamp from local-date constructors keeps the whole fixture set on one
// local day in *any* timezone. Same pattern as `use-chat.test.ts`.
const LOCAL_NOW = new Date(2026, 6, 5, 12, 0, 0); // 2026-07-05 12:00 local
const localIso = (day: number, hour: number, minute = 0, second = 0) =>
  new Date(2026, 6, day, hour, minute, second).toISOString();

const SESSION: ChatSession = {
  id: 1,
  type: "adhoc",
  started_at: localIso(5, 9),
  ended_at: null,
  summary: null,
};

const HISTORY: ChatMessage[] = [
  {
    id: 1,
    session_id: 1,
    role: "user",
    content: "おはようございます",
    interrupted: 0,
    created_at: localIso(5, 9),
  },
  {
    id: 2,
    session_id: 1,
    role: "boss",
    content: "今日は A 案件からだ。",
    interrupted: 0,
    created_at: localIso(5, 9, 0, 5),
  },
];

const BOSS_REPLY: ChatMessage = {
  id: 3,
  session_id: 1,
  role: "boss",
  content: "B 案件は後回しにしろ。",
  interrupted: 0,
  created_at: localIso(5, 10),
};

const MORNING_SESSION: ChatSession = {
  id: 20,
  type: "morning",
  started_at: localIso(5, 8),
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

/**
 * Like `sseResponse`, but the caller controls exactly when each chunk is
 * enqueued via the returned `push`/`close`, instead of `sseResponse`
 * enqueueing all of them synchronously inside `start()`. Needed to observe a
 * genuine mid-stream moment (GAP-25): chunks enqueued synchronously all
 * resolve through a chain of microtasks with no real gap in between, so by
 * the time any macrotask-based check (e.g. `waitFor`/`findBy*`) runs, the
 * whole stream has already fully drained to its final state. A controllable
 * stream leaves `reader.read()` genuinely pending between pushes, giving a
 * real point in time at which the mid-stream state can actually be observed.
 */
function controllableSseStream() {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    response: { ok: true, status: 200, body },
    push(chunk: string) {
      streamController?.enqueue(encoder.encode(chunk));
    },
    close() {
      streamController?.close();
    },
  };
}

beforeEach(() => {
  // Only `Date` is faked so React Testing Library's `waitFor` (real
  // `setTimeout` polling) keeps working. `SESSION.started_at` above is on
  // 2026-07-05 *local*, and `LOCAL_NOW` is midday on that same local date,
  // so the adhoc daily cutoff sees them as the same day in any timezone.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LOCAL_NOW);
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
    mentoringRequired: false,
    activeSessionId: null,
    mentoringTarget: null,
    startMentoring: vi.fn(),
    clearMentoringTarget: vi.fn(),
    draft: "",
    setDraft: vi.fn(),
    send: vi.fn(),
    rewrite: vi.fn(),
    stop: vi.fn(),
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

  // AC-11 (Issue #272). Every timestamp is derived from `localIso` on the
  // same local date as `LOCAL_NOW`, so the session is unambiguously on
  // today's local day in any timezone (ADR 0007 決定5) without this test
  // having to model a day boundary.
  it("renders the meeting start and end boundaries around the meeting's messages", async () => {
    const endedMorning: ChatSession = {
      ...MORNING_SESSION,
      started_at: localIso(5, 9),
      ended_at: localIso(5, 10),
    };
    const morningHistory: ChatMessage[] = [
      {
        id: 30,
        session_id: 20,
        role: "user",
        content: "今日の予定です",
        interrupted: 0,
        created_at: localIso(5, 9, 30),
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([endedMorning]))
        .mockResolvedValue(jsonResponse(morningHistory)),
    );

    render(<ChatViewHarness />);

    await waitFor(() =>
      expect(screen.getByText("朝会が開始されました")).toBeInTheDocument(),
    );
    expect(screen.getByText("今日の予定です")).toBeInTheDocument();
    expect(screen.getByText("朝会が終了しました")).toBeInTheDocument();

    // The boundaries bracket the meeting's messages in DOM order, which is
    // what makes "どこからどこまでが会か" readable while scrolling.
    const timeline = screen.getByRole("list", { name: "会話履歴" });
    expect(
      Array.from(timeline.children).map((item) => item.textContent),
    ).toEqual(["朝会が開始されました", "自分今日の予定です", "朝会が終了しました"]);
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

  it("renders the streaming reply as it grows, before the boss's message is appended (GAP-25)", async () => {
    const stream = controllableSseStream();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse([SESSION]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(stream.response),
    );

    render(<ChatViewHarness />);
    await waitFor(() =>
      expect(screen.getByLabelText("メッセージ")).toBeEnabled(),
    );

    fireEvent.change(screen.getByLabelText("メッセージ"), {
      target: { value: "進捗を教えて" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    stream.push('event: text\ndata: {"text":"考え中"}\n\n');
    await screen.findByText("考え中");
    expect(
      screen.queryByText("B 案件は後回しにしろ。"),
    ).not.toBeInTheDocument();

    stream.push('event: text\ndata: {"text":"です…"}\n\n');
    await screen.findByText("考え中です…");

    stream.push(`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`);
    stream.close();
    await waitFor(() =>
      expect(screen.getByText("B 案件は後回しにしろ。")).toBeInTheDocument(),
    );
    // The streaming bubble must be cleared once the final message lands, or
    // its last mid-stream text would double up alongside the appended reply.
    expect(screen.queryByText("考え中です…")).not.toBeInTheDocument();
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

  // Issue #254 で意図的に変えた契約: 生成中のボタンは「送信中…」で disabled
  // ではなく、押せる停止ボタンに置き換わる（無効なボタンを見せて待たせる
  // のをやめた）。入力欄が disabled のままなのは本 Issue のスコープ外として
  // 据え置いた点なので、引き続き固定する。
  it("swaps the send button for an enabled stop button while a message is in flight, and keeps the input disabled (#254)", async () => {
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
      expect(screen.getByRole("button", { name: "生成を停止" })).toBeEnabled(),
    );
    expect(screen.queryByRole("button", { name: "送信" })).toBeNull();
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

  it("shows the generic tool-executed notice — not a task-update claim — when a read-only tool (e.g. get_activity_log) runs (GAP-28; self-review: get_activity_log previously fell into the create_task/update_task-only notice text)", async () => {
    const toolEvent = {
      name: "get_activity_log",
      input: { task_id: 5 },
      result: JSON.stringify({ events: [], truncated: false }),
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
      target: { value: "完了しました" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送信" }));

    await waitFor(() =>
      expect(
        screen.getByText("ボスがツールを実行しました"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/タスクを更新しました/)).not.toBeInTheDocument();
    expect(screen.queryByText(/タスクを作成しました/)).not.toBeInTheDocument();
  });

  it("shows a tool-failure notice when the tool event reports isError (GAP-28)", async () => {
    const toolEvent = {
      name: "create_task",
      input: { title: "資料作成" },
      result: JSON.stringify({ error: "database is locked" }),
      isError: true,
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
        screen.getByText("ツールの実行に失敗しました（create_task）"),
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
        .mockResolvedValueOnce(jsonResponse(MORNING_SESSION, 201)) // create
        .mockResolvedValueOnce(jsonResponse([])), // Issue #271: opening-line re-fetch (none generated)
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
        .mockResolvedValueOnce(jsonResponse([])) // Issue #271: opening-line re-fetch (none generated)
        .mockResolvedValueOnce(
          jsonResponse({ ...MORNING_SESSION, ended_at: localIso(5, 9) }),
        )
        // Issue #272: ending rebuilds the whole timeline, so `endSession`
        // re-lists the sessions (and then their messages) instead of
        // restoring an in-memory snapshot. This test only cares about the
        // session bar, so an empty day is enough.
        .mockResolvedValue(jsonResponse([])),
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
        .mockResolvedValueOnce(jsonResponse(eveningSession, 201))
        .mockResolvedValueOnce(jsonResponse([])), // Issue #271: opening-line re-fetch (none generated)
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

// Issue #254: 停止 UI。ここは `makeChatState` で chatState を直接与える形で
// 書く（この describe が検証するのは「画面が chatState をどう読み・どう
// stop を呼ぶか」であり、フック側の停止の中身は use-chat.test.ts が持つ）。
describe("ChatView stop UI (Issue #254)", () => {
  it("shows the send button, not a stop button, when nothing is being generated", () => {
    render(<ChatView chatState={makeChatState({ sending: false })} />);

    expect(screen.getByRole("button", { name: "送信" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成を停止" })).toBeNull();
  });

  it("calls stop when the stop button is clicked", () => {
    const stop = vi.fn();
    render(<ChatView chatState={makeChatState({ sending: true, stop })} />);

    fireEvent.click(screen.getByRole("button", { name: "生成を停止" }));

    expect(stop).toHaveBeenCalledTimes(1);
  });

  // ESC のハンドラを textarea に付けると、生成中の textarea は disabled で
  // キーイベントが発火しないため動かない。document 購読になっていることを
  // 「フォーカスがどこにも無い状態で押しても効く」形で固定する。
  it("stops the generation on Escape while generating, without needing focus in the textarea", () => {
    const stop = vi.fn();
    render(<ChatView chatState={makeChatState({ sending: true, stop })} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop on an Escape that cancels an IME composition", () => {
    const stop = vi.fn();
    render(<ChatView chatState={makeChatState({ sending: true, stop })} />);

    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    fireEvent.keyDown(document, { key: "Escape", keyCode: 229 });

    expect(stop).not.toHaveBeenCalled();
  });

  it("does not stop on Escape when nothing is being generated", () => {
    const stop = vi.fn();
    render(<ChatView chatState={makeChatState({ sending: false, stop })} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(stop).not.toHaveBeenCalled();
  });

  it("stops listening for Escape once the generation has finished", () => {
    const stop = vi.fn();
    const { rerender } = render(
      <ChatView chatState={makeChatState({ sending: true, stop })} />,
    );
    rerender(<ChatView chatState={makeChatState({ sending: false, stop })} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(stop).not.toHaveBeenCalled();
  });

  it("renders an interrupted boss reply distinguishably from a complete one", () => {
    const { container } = render(
      <ChatView
        chatState={makeChatState({
          entries: [
            {
              kind: "message",
              key: "message-1",
              role: "boss",
              content: "最後まで書いた",
            },
            {
              kind: "message",
              key: "message-2",
              role: "boss",
              content: "まずは見積",
              interrupted: true,
            },
          ],
        })}
      />,
    );

    const interrupted = container.querySelectorAll(".chat-message-interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].textContent).toContain("まずは見積");
    expect(screen.getByText("ここで停止しました")).toBeInTheDocument();
  });

  // 中断表示が既存の 2 つの語彙（ツール通知・会の境界）と衝突していないこと。
  // 同じクラス名を使い回すと、片方のスタイル調整がもう片方を壊す。
  it("uses a class distinct from the tool notice and the meeting boundary", () => {
    const { container } = render(
      <ChatView
        chatState={makeChatState({
          entries: [
            {
              kind: "message",
              key: "message-1",
              role: "boss",
              content: "まずは見積",
              interrupted: true,
            },
          ],
        })}
      />,
    );

    const interrupted = container.querySelector(".chat-message-interrupted");
    expect(interrupted).not.toBeNull();
    expect(interrupted!.classList.contains("chat-tool-notice")).toBe(false);
    expect(interrupted!.classList.contains("chat-boundary")).toBe(false);
  });

  it("keeps tool notices on screen alongside an interrupted reply, and adds no extra notice about them", () => {
    render(
      <ChatView
        chatState={makeChatState({
          entries: [
            {
              kind: "tool",
              key: "tool-1",
              tool: {
                name: "create_task",
                input: {},
                result: JSON.stringify({ title: "資料作成" }),
                isError: false,
              },
            },
            {
              kind: "message",
              key: "message-1",
              role: "boss",
              content: "まずは見積",
              interrupted: true,
            },
          ],
        })}
      />,
    );

    // 実行済みツールの通知はそのまま残る（副作用は巻き戻さないため）。
    expect(
      screen.getByText("ボスがタスクを作成しました: 資料作成"),
    ).toBeInTheDocument();
    // 「取り消されていません」といった追加の通知は出さない（#254 論点6）。
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});

// Issue #379 (#255 決定6): 発言のインライン編集 UI と削除範囲の確認 UI。
// `makeChatState` で chatState を直接与える形で書く（この describe が検証
// するのは「画面が chatState / entries をどう読み、どう rewrite を呼ぶか」
// であり、`rewrite` 自身の中身は use-chat.test.ts が持つ）。
describe("ChatView rewrite UI (Issue #379)", () => {
  const activeSessionId = 1;

  function baseChatState(overrides: Partial<UseChatResult> = {}): UseChatResult {
    return makeChatState({ activeSessionId, ...overrides });
  }

  it("shows an edit affordance on the active session's own persisted message (AC-39)", () => {
    render(
      <ChatView
        chatState={baseChatState({
          entries: [
            {
              kind: "message",
              key: "message-10",
              role: "user",
              content: "相談です",
              messageId: 10,
              sessionId: activeSessionId,
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "発言を編集" }),
    ).toBeInTheDocument();
  });

  it("does not show an edit affordance on the boss's message (AC-40)", () => {
    render(
      <ChatView
        chatState={baseChatState({
          entries: [
            {
              kind: "message",
              key: "message-11",
              role: "boss",
              content: "了解した。",
              messageId: 11,
              sessionId: activeSessionId,
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "発言を編集" }),
    ).not.toBeInTheDocument();
  });

  it("does not show an edit affordance on a message from a finished session (AC-41)", () => {
    render(
      <ChatView
        chatState={baseChatState({
          entries: [
            {
              kind: "message",
              key: "message-12",
              role: "user",
              content: "終わった朝会の発言",
              messageId: 12,
              sessionId: 99,
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "発言を編集" }),
    ).not.toBeInTheDocument();
  });

  it("does not show an edit affordance on an optimistically appended message without a messageId (AC-42)", () => {
    render(
      <ChatView
        chatState={baseChatState({
          entries: [
            {
              kind: "message",
              key: "message-local-1",
              role: "user",
              content: "送信直後",
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "発言を編集" }),
    ).not.toBeInTheDocument();
  });

  it("does not show an edit affordance while a reply is being generated (AC-43)", () => {
    render(
      <ChatView
        chatState={baseChatState({
          sending: true,
          entries: [
            {
              kind: "message",
              key: "message-10",
              role: "user",
              content: "相談です",
              messageId: 10,
              sessionId: activeSessionId,
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "発言を編集" }),
    ).not.toBeInTheDocument();
  });

  // AC-39〜43 の4条件に加え、画面の仕様が「既存の会の開始／終了ボタンと同じ
  // 抑止条件に揃える」としている `switching` も同じ扱いになることを固定する
  // （AC 番号は割り当てられていないが、完了条件の一部）。
  it("does not show an edit affordance while a session switch is in flight", () => {
    render(
      <ChatView
        chatState={baseChatState({
          switching: true,
          entries: [
            {
              kind: "message",
              key: "message-10",
              role: "user",
              content: "相談です",
              messageId: 10,
              sessionId: activeSessionId,
            },
          ],
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "発言を編集" }),
    ).not.toBeInTheDocument();
  });

  /**
   * A timeline with: an interrupted boss reply that precedes the editable
   * target (never part of any rewrite range, and used to prove the highlight
   * doesn't leak onto unrelated entries), the editable user message itself,
   * a tool notice, and a boss reply after it — all in `activeSessionId`.
   */
  function editableTimeline(): ChatEntry[] {
    return [
      {
        kind: "message",
        key: "message-9",
        role: "boss",
        content: "先に途切れた応答",
        messageId: 9,
        sessionId: activeSessionId,
        interrupted: true,
      },
      {
        kind: "message",
        key: "message-10",
        role: "user",
        content: "相談です",
        messageId: 10,
        sessionId: activeSessionId,
      },
      {
        kind: "tool",
        key: "tool-1",
        tool: {
          name: "create_task",
          input: {},
          result: "{}",
          isError: false,
        },
      },
      {
        kind: "message",
        key: "message-11",
        role: "boss",
        content: "了解した。",
        messageId: 11,
        sessionId: activeSessionId,
      },
    ];
  }

  /**
   * Renders `editableTimeline()` and starts editing its target user message
   * (message-10). Used by every test below that needs the edit form already
   * open.
   */
  function renderWithEditableMessage() {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rewrite = vi.fn();
    const utils = render(
      <ChatView
        chatState={baseChatState({ rewrite, entries: editableTimeline() })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "発言を編集" }));
    return { ...utils, fetchMock, rewrite };
  }

  it("does not call fetch or rewrite merely by starting an edit (AC-44)", () => {
    const { fetchMock, rewrite } = renderWithEditableMessage();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("shows the deletion count with the target message included in the total (AC-45)", () => {
    renderWithEditableMessage();

    // target (user) + boss reply after it = 2 messages; the tool notice is
    // not a message and so is not counted (決定 6 の内訳は発言のみ). The
    // interrupted boss reply *before* the target is in a different part of
    // the timeline and must not be counted either.
    expect(
      screen.getByText(
        "この操作でこの発言を含む2件（あなたの発言1件・ボスの応答1件）が削除されます",
      ),
    ).toBeInTheDocument();
  });

  it("warns that already-executed operations cannot be undone, with the exact default wording (AC-46)", () => {
    renderWithEditableMessage();

    expect(
      screen.getByText("すでに実行された操作は取り消されません"),
    ).toBeInTheDocument();
  });

  it("highlights only the entries that will actually be deleted, leaving an unrelated interrupted entry marked solely with its own class (AC-47, AC-48)", () => {
    const { container } = renderWithEditableMessage();

    // The edited message itself becomes the edit form (no longer a bubble to
    // highlight) — the tool notice and the boss reply after it are what gets
    // highlighted. `.chat-rewrite-target` is a class distinct from the three
    // existing vocabularies (AC-48): if it ever collided with one of them,
    // the interrupted entry below (which never enters a rewrite range) would
    // wrongly pick up the highlight too, which the last assertion catches.
    const highlighted = container.querySelectorAll(".chat-rewrite-target");
    expect(highlighted).toHaveLength(2);
    expect(highlighted[0]).toHaveClass("chat-tool-notice");
    expect(highlighted[1]).toHaveTextContent("了解した。");

    const interrupted = container.querySelector(".chat-message-interrupted");
    expect(interrupted).not.toBeNull();
    expect(interrupted!.classList.contains("chat-rewrite-target")).toBe(false);
  });

  it("calls rewrite with the edited content when the confirm action is pressed (AC-49)", () => {
    const { rewrite } = renderWithEditableMessage();

    fireEvent.change(screen.getByLabelText("書き直す内容"), {
      target: { value: "書き直した内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送り直す" }));

    expect(rewrite).toHaveBeenCalledWith(10, "書き直した内容");
  });

  it("closes the form and re-enables the normal controls once confirm is pressed, without adding or removing listitems (AC-49)", () => {
    const { container } = renderWithEditableMessage();
    // Baseline: 4 entries in `editableTimeline()` are 4 listitems while the
    // form is open (the form replaces the target's own listitem rather than
    // adding one — the existing `getAllByRole("listitem")` contract).
    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    fireEvent.change(screen.getByLabelText("書き直す内容"), {
      target: { value: "書き直した内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送り直す" }));

    // `confirmEdit` clears the local editing state synchronously (before
    // `rewrite`'s promise settles) — with `chatState.sending` staying `false`
    // here (a mocked `rewrite` never flips it), the screen must already show
    // the normal, non-editing view.
    expect(screen.queryByLabelText("書き直す内容")).not.toBeInTheDocument();
    expect(screen.getByLabelText("メッセージ")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "発言を編集" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(container.querySelectorAll(".chat-rewrite-target")).toHaveLength(0);
  });

  it("returns to the normal view without calling fetch or changing the timeline when cancelled (AC-50)", () => {
    const { fetchMock, rewrite } = renderWithEditableMessage();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rewrite).not.toHaveBeenCalled();
    expect(screen.getByText("相談です")).toBeInTheDocument();
    expect(screen.getByText("了解した。")).toBeInTheDocument();
    expect(screen.queryByLabelText("書き直す内容")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "発言を編集" }),
    ).toBeInTheDocument();
  });

  it("disables the normal message input while editing (AC-51)", () => {
    renderWithEditableMessage();

    expect(screen.getByLabelText("メッセージ")).toBeDisabled();
  });

  it("disables the confirm action while the edit form is whitespace-only (AC-52)", () => {
    renderWithEditableMessage();

    fireEvent.change(screen.getByLabelText("書き直す内容"), {
      target: { value: "   \n  " },
    });

    expect(screen.getByRole("button", { name: "送り直す" })).toBeDisabled();
  });

  it("focuses the edit textarea as soon as editing starts, so it is reachable without an extra Tab", () => {
    renderWithEditableMessage();

    expect(screen.getByLabelText("書き直す内容")).toHaveFocus();
  });

  // self-review (Issue #379): starting/ending a meeting changes
  // `activeSessionId`, which the open edit form's preview
  // (`selectRewriteRange`) is scoped to — switching mid-edit used to leave
  // the edit state stuck with no way back (the bottom input disabled, no
  // affordance to cancel). Disabling the session-bar buttons while editing
  // closes that path entirely.
  it("disables the morning/evening start buttons while an edit is open", () => {
    renderWithEditableMessage();

    expect(
      screen.getByRole("button", { name: "朝会を開始" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "夕会を開始" }),
    ).toBeDisabled();
  });

  it("disables the meeting-end button while an edit is open", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ChatView
        chatState={baseChatState({
          sessionType: "morning",
          entries: editableTimeline(),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "発言を編集" }));

    expect(
      screen.getByRole("button", { name: "朝会を終了" }),
    ).toBeDisabled();
  });

  // self-review (Issue #379): `confirmEdit` clears the form before `rewrite`
  // settles (mirroring `send`'s "clear the input immediately" behavior) —
  // but unlike `send`, a rewrite has no optimistic entry keeping the typed
  // text on screen. These two tests drive `chatState.sending`/`error`
  // through the same true→false transition `rewrite` itself goes through,
  // to fix the resulting gap: a failed attempt must hand the user's retyped
  // content back instead of losing it silently.
  it("reopens the edit form with the typed content when the confirmed rewrite fails", () => {
    const rewrite = vi.fn();
    const entries = editableTimeline();
    const { rerender } = render(
      <ChatView chatState={baseChatState({ rewrite, entries })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "発言を編集" }));
    fireEvent.change(screen.getByLabelText("書き直す内容"), {
      target: { value: "書き直した内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送り直す" }));
    expect(screen.queryByLabelText("書き直す内容")).not.toBeInTheDocument();

    // `rewrite` starts generating...
    rerender(
      <ChatView
        chatState={baseChatState({ rewrite, entries, sending: true })}
      />,
    );
    // ...and then fails; the server never committed, so the target message
    // is still in `entries` unchanged.
    rerender(
      <ChatView
        chatState={baseChatState({
          rewrite,
          entries,
          sending: false,
          error: "書き直しに失敗しました",
        })}
      />,
    );

    expect(screen.getByLabelText("書き直す内容")).toHaveValue("書き直した内容");
  });

  it("does not reopen the edit form when the confirmed rewrite is merely stopped (no error surfaced)", () => {
    const rewrite = vi.fn();
    const entries = editableTimeline();
    const { rerender } = render(
      <ChatView chatState={baseChatState({ rewrite, entries })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "発言を編集" }));
    fireEvent.change(screen.getByLabelText("書き直す内容"), {
      target: { value: "書き直した内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "送り直す" }));

    rerender(
      <ChatView
        chatState={baseChatState({ rewrite, entries, sending: true })}
      />,
    );
    // A stop does not set `error` (AC-23-like treatment) — `rewrite`'s own
    // unconditional refresh is what shows the outcome instead.
    rerender(
      <ChatView
        chatState={baseChatState({ rewrite, entries, sending: false, error: null })}
      />,
    );

    expect(screen.queryByLabelText("書き直す内容")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "発言を編集" }),
    ).toBeInTheDocument();
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

// Issue #411 (親 #276 判断2・判断6): 朝会終了ブロックの UI 分岐と随時
// メンタリングの導線。`makeChatState` で chatState を直接与える形で書く
// （ChatView rewrite UI の describe と同じ理由: 検証するのは「画面が
// chatState をどう読み、どうボタンを呼ぶか」であり、`send`/`endSession`
// 自身の中身は use-chat.test.ts が持つ）。
describe("ChatView mentoring (Issue #411)", () => {
  const MENTORING_BUTTON_NAME = "進め方を点検してもらう";

  it("shows the ad-hoc mentoring button during the ad-hoc chat (AC-29)", () => {
    render(<ChatView chatState={makeChatState({ sessionType: "adhoc" })} />);

    expect(
      screen.getByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).toBeInTheDocument();
  });

  // 変異確認の対になるテスト: 表示条件を「常に表示」に壊すとこの2件
  // （morning/evening）が落ち、「常に非表示」に壊すと AC-29 側が落ちる。
  it("does not show the mentoring button during a morning meeting (AC-30)", () => {
    render(<ChatView chatState={makeChatState({ sessionType: "morning" })} />);

    expect(
      screen.queryByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).not.toBeInTheDocument();
  });

  it("does not show the mentoring button during an evening meeting (AC-30)", () => {
    render(<ChatView chatState={makeChatState({ sessionType: "evening" })} />);

    expect(
      screen.queryByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).not.toBeInTheDocument();
  });

  it("sends a fixed message with the mentoring option when the button is pressed", () => {
    const send = vi.fn();
    render(
      <ChatView chatState={makeChatState({ sessionType: "adhoc", send })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: MENTORING_BUTTON_NAME }));

    expect(send).toHaveBeenCalledTimes(1);
    // The flag is what makes the server queue MENTORING_FLOW_INSTRUCTION
    // (親 #276 判断6) — a plain send without it would leave 随時メンタリング
    // without a record (`record_mentoring` never gets called). Issue #470
    // (親 #444 決定4): the second argument is now an options object, and this
    // header-origin send must not carry a mentoringTaskId (AC-10) — it is
    // not attributed to any task card.
    expect(send).toHaveBeenCalledWith("今の進め方を見てほしい", {
      mentoring: true,
    });
  });

  it("disables the mentoring button while sending or switching", () => {
    const { rerender } = render(
      <ChatView
        chatState={makeChatState({ sessionType: "adhoc", sending: true })}
      />,
    );
    expect(
      screen.getByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).toBeDisabled();

    rerender(
      <ChatView
        chatState={makeChatState({ sessionType: "adhoc", switching: true })}
      />,
    );
    expect(
      screen.getByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).toBeDisabled();
  });

  it("disables the mentoring button while an inline edit is open", () => {
    const activeSessionId = 1;
    render(
      <ChatView
        chatState={makeChatState({
          sessionType: "adhoc",
          activeSessionId,
          entries: [
            {
              kind: "message",
              key: "message-10",
              role: "user",
              content: "相談です",
              messageId: 10,
              sessionId: activeSessionId,
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "発言を編集" }));

    expect(
      screen.getByRole("button", { name: MENTORING_BUTTON_NAME }),
    ).toBeDisabled();
  });

  // AC-39: 分岐は `code` 由来の `mentoringRequired` で行い、`error`（文言）
  // では行わない — この状態表示は `error` が null のままでも出る。
  // AC-40: 設定でオフにできる旨を必ず含む(これを欠くと、ボスが記録を残さ
  // なかった場合にユーザーが朝会から抜ける手段を画面から見つけられない)。
  it("shows a status notice mentioning the settings escape hatch when blocked (AC-39, AC-40)", () => {
    render(
      <ChatView
        chatState={makeChatState({
          sessionType: "morning",
          mentoringRequired: true,
          error: null,
        })}
      />,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("メンタリング");
    expect(notice).toHaveTextContent("設定");
    expect(notice).toHaveTextContent(/オフ/);
  });

  it("does not show the blocked status notice when not blocked", () => {
    render(
      <ChatView
        chatState={makeChatState({
          sessionType: "morning",
          mentoringRequired: false,
        })}
      />,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// Issue #476 (S1b・決定10・決定11): 「相談中」の可視化と解除導線。表示位置は
// セッションヘッダの帯（chat-timeline の外）で、発言としてタイムラインへは
// 混ざらない。
describe("ChatView 相談中 state (Issue #476, S1b)", () => {
  it("shows the target task's title and a clear affordance when mentoringTarget is set", () => {
    render(
      <ChatView
        chatState={makeChatState({
          mentoringTarget: { id: 42, title: "資料を作る" },
        })}
      />,
    );

    expect(screen.getByText("「資料を作る」について相談中")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "相談を終える" }),
    ).toBeInTheDocument();
  });

  it("does not show the 相談中 state when mentoringTarget is null", () => {
    render(<ChatView chatState={makeChatState({ mentoringTarget: null })} />);

    expect(
      screen.queryByText(/について相談中/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "相談を終える" }),
    ).not.toBeInTheDocument();
  });

  it("calls clearMentoringTarget when the clear affordance is clicked", () => {
    const clearMentoringTarget = vi.fn();
    render(
      <ChatView
        chatState={makeChatState({
          mentoringTarget: { id: 42, title: "資料を作る" },
          clearMentoringTarget,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "相談を終える" }));

    expect(clearMentoringTarget).toHaveBeenCalledTimes(1);
  });

  // 決定10の画面仕様: 状態であって発言ではないので、会話の並び
  // （aria-label="会話履歴" のリスト）には混ざらない。
  it("renders the 相談中 state outside the conversation timeline list", () => {
    render(
      <ChatView
        chatState={makeChatState({
          mentoringTarget: { id: 42, title: "資料を作る" },
        })}
      />,
    );

    const timeline = screen.getByRole("list", { name: "会話履歴" });
    expect(
      within(timeline).queryByText("「資料を作る」について相談中"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("「資料を作る」について相談中")).toBeInTheDocument();
  });

  // 決定11: 全日単位メンタリングボタンは対象タスク無しの状態へ解除する。
  // 送信自体の形（`mentoring: true` のみ・`mentoringTaskId` 無し）は
  // #491 の範囲で変えない。
  it("clears the mentoring target when the header 全日単位 mentoring button is clicked, without changing what it sends", () => {
    const clearMentoringTarget = vi.fn();
    const send = vi.fn();
    render(
      <ChatView
        chatState={makeChatState({
          sessionType: "adhoc",
          mentoringTarget: { id: 42, title: "資料を作る" },
          clearMentoringTarget,
          send,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "進め方を点検してもらう" }),
    );

    expect(clearMentoringTarget).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("今の進め方を見てほしい", {
      mentoring: true,
    });
  });
});
