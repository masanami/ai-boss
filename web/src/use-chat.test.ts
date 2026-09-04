import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChat } from "./use-chat";
import type { ChatMessage, ChatSession } from "./chat";

// Local-time anchors: `isSameLocalDay` compares local dates, so all
// "today"/"yesterday" session timestamps are derived from local-date
// constructors (not fixed UTC strings) to stay TZ-independent.
// Message timestamps are local-derived too (not UTC literals): Issue #272
// merges several sessions into one chronological timeline, so the *relative*
// order of session boundaries and messages is now asserted — mixing
// local-derived session times with UTC-literal message times would make that
// order depend on the runner's timezone (ADR 0007 決定5).
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
  content: "その相談なら B 案件を後回しにしろ。",
  interrupted: 0,
  created_at: localIso(5, 10),
};

// Started the local day before the fake "now" set in beforeEach below.
const YESTERDAY_ADHOC_SESSION: ChatSession = {
  id: 9,
  type: "adhoc",
  started_at: localIso(4, 9),
  ended_at: null,
  summary: null,
};

const MORNING_SESSION_TODAY: ChatSession = {
  id: 20,
  type: "morning",
  started_at: localIso(5, 8),
  ended_at: null,
  summary: null,
};

const MORNING_SESSION_YESTERDAY: ChatSession = {
  id: 19,
  type: "morning",
  started_at: localIso(4, 8),
  ended_at: null,
  summary: null,
};

const MORNING_HISTORY: ChatMessage[] = [
  {
    id: 30,
    session_id: 20,
    role: "user",
    content: "今日の予定です",
    interrupted: 0,
    created_at: localIso(5, 8, 5),
  },
];

// Issue #271: `POST /api/sessions` may generate this as a synchronous side
// effect for a brand-new morning/evening session, before the client sends
// anything. `startSession` cannot assume it from the create response alone
// (the server response shape didn't change — re-fetch is how the client
// picks it up), so it must be modeled as a follow-up
// `GET /api/sessions/:id/messages` response in these tests.
const MORNING_OPENING_MESSAGE: ChatMessage = {
  id: 31,
  session_id: 20,
  role: "boss",
  content: "今日はA案件から片付けろ。",
  interrupted: 0,
  created_at: localIso(5, 8, 0, 1),
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(body) };
}

interface RoutedFetchState {
  /** Sessions returned by `GET /api/sessions`. Mutated in place by the
   * create/end routes so later reads observe earlier writes, like the real
   * server does. */
  sessions: ChatSession[];
  /** Messages per session id, keyed for `GET /api/sessions/:id/messages`. */
  messages?: Record<number, ChatMessage[]>;
  /** Session returned by `POST /api/sessions` (and appended to `sessions`). */
  created?: ChatSession;
  /** SSE response for `POST /api/sessions/:id/messages`. */
  stream?: unknown;
}

/**
 * A `fetch` stub that dispatches on URL + method instead of on call order.
 *
 * Issue #272 made the call sequence data-dependent: `loadTimeline` fetches
 * messages for *every* session in today's view, so the number and order of
 * requests now varies with the session list. Ordered
 * `mockResolvedValueOnce` chains encoded the old fixed sequence and broke on
 * changes that were not actually regressions; routing by URL keeps these
 * tests pinned to the observable contract (what is requested, and what the
 * hook does with the answers) rather than to an incidental ordering.
 */
function routedFetch(state: RoutedFetchState) {
  // Later than every fixture timestamp (and than LOCAL_NOW), so an ended
  // session's closing boundary always lands at the end of the timeline.
  const endedAt = localIso(5, 13);
  return vi.fn((url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";

    if (url === "/api/sessions" && method === "POST") {
      const created = state.created;
      if (created === undefined) {
        throw new Error(`unexpected POST /api/sessions (no "created" configured)`);
      }
      state.sessions = [...state.sessions, created];
      return Promise.resolve(jsonResponse(created, 201));
    }
    if (url === "/api/sessions") {
      return Promise.resolve(jsonResponse(state.sessions));
    }

    const endMatch = /^\/api\/sessions\/(\d+)\/end$/.exec(url);
    if (endMatch) {
      const id = Number(endMatch[1]);
      const ended = { ...state.sessions.find((s) => s.id === id)!, ended_at: endedAt };
      state.sessions = state.sessions.map((s) => (s.id === id ? ended : s));
      return Promise.resolve(jsonResponse(ended));
    }

    const messagesMatch = /^\/api\/sessions\/(\d+)\/messages$/.exec(url);
    if (messagesMatch) {
      if (method === "POST") {
        return Promise.resolve(state.stream);
      }
      return Promise.resolve(
        jsonResponse(state.messages?.[Number(messagesMatch[1])] ?? []),
      );
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

/** The URLs requested, in order — for asserting *what* was fetched without
 * pinning the exact interleaving. */
function requestedUrls(fetchMock: ReturnType<typeof routedFetch>): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
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
  // Only `Date` is faked (not timers), so React Testing Library's `waitFor`
  // (which polls via real `setTimeout`) keeps working. "now" is fixed to the
  // same local day as `SESSION.started_at` (both derived from local dates).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LOCAL_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// The hook's own state contract for `draft`/`setDraft` (Issue #153, same
// pattern as the rest of `UseChatResult`), including that the value survives
// the hook's own startSession/endSession session switches (GAP-19).
//
// This deliberately does NOT attempt to reproduce "the consuming component
// unmounts and remounts" at the hook level. An earlier version of this test
// rendered a small hand-rolled harness (a parent holding `useChat()` plus a
// child, toggled on/off, that merely displayed `chat.draft`) and asserted
// the draft survived the child's unmount/remount — but that assertion could
// never fail: `draft` lives in the *parent's* `useState`, so no `useChat`
// implementation could lose it just because an unrelated child unmounted.
// That harness was a tautological test (self-review finding) and was
// removed. The real "draft survives leaving/revisiting the chat tab"
// regression test lives in AppLayout.test.tsx's real conditional-rendering
// integration test instead ("keeps the chat draft across a chat -> tasks ->
// chat round trip"), which actually mounts/unmounts `ChatView` itself.
// ChatView.test.tsx only covers that ChatView reads/writes
// `chatState.draft`/`setDraft` (wiring), not the unmount/remount survival
// itself.
describe("useChat draft", () => {
  it("initializes draft as an empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.draft).toBe("");
  });

  it("updates draft via setDraft", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse([])));

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.setDraft("書きかけの相談");
    });

    expect(result.current.draft).toBe("書きかけの相談");
  });

  it("keeps the draft across startSession/endSession session switches, which actually happen (GAP-19)", async () => {
    const fetchMock = routedFetch({
      sessions: [],
      created: MORNING_SESSION_TODAY,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.setDraft("書きかけの相談");
    });

    await act(async () => {
      await result.current.startSession("morning");
    });
    // Asserting sessionType alongside draft proves the switch actually
    // happened (a startSession/endSession that regressed into an early-return
    // no-op would otherwise leave draft untouched and this test green without
    // ever exercising the switch it is named for).
    expect(result.current.sessionType).toBe("morning");
    expect(result.current.draft).toBe("書きかけの相談");

    await act(async () => {
      await result.current.endSession();
    });
    expect(result.current.sessionType).toBe("adhoc");
    expect(result.current.draft).toBe("書きかけの相談");
  });
});

describe("useChat", () => {
  it("restores the history of the latest adhoc session on mount", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse(HISTORY));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.entries).toEqual([
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
    ]);
  });

  it("is ready with no entries when no adhoc session exists", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.entries).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sets an error status when history restoration fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network error")),
    );

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("creates a session on first send, then appends the user entry and the streamed boss reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(SESSION, 201))
      .mockResolvedValueOnce(
        sseResponse([
          'event: text\ndata: {"text":"その相談なら"}\n\n',
          `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("相談があります");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adhoc" }),
    });
    expect(result.current.entries).toEqual([
      { kind: "message", key: "user-local-1", role: "user", content: "相談があります" },
      { kind: "message", key: "message-3", role: "boss", content: BOSS_REPLY.content },
    ]);
    expect(result.current.sending).toBe(false);
    expect(result.current.streamingText).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("grows streamingText as SSE text deltas arrive, before the reply is complete (GAP-25)", async () => {
    const stream = controllableSseStream();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(stream.response);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let sendPromise: Promise<void> = Promise.resolve();
    act(() => {
      sendPromise = result.current.send("進捗を教えて");
    });

    stream.push('event: text\ndata: {"text":"考え中"}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe("考え中"));
    // The reply has not been appended yet: this is a genuine mid-stream
    // observation, not the post-completion state.
    expect(
      result.current.entries.some(
        (entry) => entry.kind === "message" && entry.role === "boss",
      ),
    ).toBe(false);

    stream.push('event: text\ndata: {"text":"です…"}\n\n');
    await waitFor(() =>
      expect(result.current.streamingText).toBe("考え中です…"),
    );

    stream.push(`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`);
    stream.close();
    await act(async () => {
      await sendPromise;
    });

    expect(result.current.streamingText).toBe("");
    expect(result.current.entries).toContainEqual({
      kind: "message",
      key: "message-3",
      role: "boss",
      content: BOSS_REPLY.content,
    });
  });

  it("reuses the restored session on send", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse(HISTORY))
      .mockResolvedValueOnce(
        sseResponse([`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("続きの相談です");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/sessions/1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("records tool entries emitted during the stream", async () => {
    const toolEvent = {
      name: "create_task",
      input: { title: "資料作成" },
      result: JSON.stringify({ id: 5, title: "資料作成" }),
      isError: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        sseResponse([
          `event: tool\ndata: ${JSON.stringify(toolEvent)}\n\n`,
          `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("タスク化して");
    });

    expect(result.current.entries).toContainEqual({
      kind: "tool",
      key: "tool-local-2",
      tool: toolEvent,
    });
  });

  it("surfaces an SSE error event and clears the streaming buffer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        sseResponse([
          'event: text\ndata: {"text":"途中まで"}\n\n',
          'event: error\ndata: {"error":"ボスの応答中にエラーが発生しました"}\n\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("テスト");
    });

    expect(result.current.error).toBe("ボスの応答中にエラーが発生しました");
    expect(result.current.streamingText).toBe("");
    expect(result.current.sending).toBe(false);
  });

  it("keeps the optimistic user entry when session creation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "database is locked" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("消えてほしくない相談");
    });

    expect(result.current.entries).toEqual([
      {
        kind: "message",
        key: "user-local-1",
        role: "user",
        content: "消えてほしくない相談",
      },
    ]);
    expect(result.current.error).toBe("database is locked");
    expect(result.current.sending).toBe(false);
  });

  it("ignores a second send while one is already in flight", async () => {
    let resolvePost: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePost = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first: Promise<void>;
    act(() => {
      first = result.current.send("一通目");
    });
    await act(async () => {
      await result.current.send("二通目（無視されるべき）");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    resolvePost(
      sseResponse([`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`]),
    );
    await act(async () => {
      await first;
    });
    expect(
      result.current.entries.filter((entry) => entry.kind === "message"),
    ).toHaveLength(2);
  });

  it("does not update state after unmounting mid-stream", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolvePost: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePost = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.send("送信中に画面を離れる");
    });
    unmount();

    resolvePost(
      sseResponse([
        'event: text\ndata: {"text":"届かない応答"}\n\n',
        `event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`,
      ]),
    );
    await act(async () => {
      await pending;
    });

    const actWarnings = errorSpy.mock.calls.filter(([first]) =>
      String(first).includes("not wrapped in act"),
    );
    expect(actWarnings).toEqual([]);
    errorSpy.mockRestore();
  });

  it("surfaces a request failure as an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "ANTHROPIC_API_KEY が未設定です" }),
        body: null,
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("テスト");
    });

    expect(result.current.error).toBe("ANTHROPIC_API_KEY が未設定です");
    expect(result.current.sending).toBe(false);
  });

  it("does not restore the latest adhoc session when it was started on a previous local day", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([YESTERDAY_ADHOC_SESSION]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.entries).toEqual([]);
    // Only the session-list lookup should have run; the stale session's
    // history must not be fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a new adhoc session on first send after skipping a stale daily history", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([YESTERDAY_ADHOC_SESSION]))
      .mockResolvedValueOnce(jsonResponse({ ...SESSION, id: 42 }, 201))
      .mockResolvedValueOnce(
        sseResponse([`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.send("新しい一日の相談です");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adhoc" }),
    });
    expect(result.current.error).toBeNull();
  });
});

// Issue #254: 停止（生成の打ち切り）。停止は「接続を切ること」そのものなので、
// ここでの fetch スタブは実 fetch と同じく signal の abort でストリームを
// 失敗させる。そうしないと「abort したのに何も起きない」スタブに対して
// テストが通ってしまう。
describe("useChat stop (Issue #254)", () => {
  /**
   * signal の abort で pending な read() を AbortError で失敗させる SSE
   * レスポンス。実 fetch の振る舞いに合わせている（これを省くと「abort しても
   * 何も起きない」スタブになり、停止のテストが素通りしてしまう）。
   *
   * POST ごとに新しいストリームを作る。使い回すと、1 本目を止めたあとの
   * 2 本目が「既に error 済みのストリーム」を読むことになり、停止後の再送が
   * 正常に始まるかを確かめられない。
   */
  function abortableSseStream(signal?: AbortSignal) {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    signal?.addEventListener(
      "abort",
      () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        streamController?.error(error);
      },
      { once: true },
    );
    return {
      response: { ok: true, status: 200, body },
      push(chunk: string) {
        streamController?.enqueue(encoder.encode(chunk));
      },
    };
  }

  function stubFetchForStop() {
    const streams: ReturnType<typeof abortableSseStream>[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(
      (url: string, init?: { method?: string; signal?: AbortSignal }) => {
        const method = init?.method ?? "GET";
        if (url === "/api/sessions" && method === "GET") {
          return Promise.resolve(jsonResponse([SESSION]));
        }
        if (/^\/api\/sessions\/\d+\/messages$/.test(url) && method === "POST") {
          signals.push(init?.signal);
          const stream = abortableSseStream(init?.signal);
          streams.push(stream);
          return Promise.resolve(stream.response);
        }
        if (/^\/api\/sessions\/\d+\/messages$/.test(url)) {
          return Promise.resolve(jsonResponse([]));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      /** 直近の POST が受け取ったストリーム。 */
      latestStream: () => streams[streams.length - 1],
      /** 直近の POST が受け取った signal。 */
      latestSignal: () => signals[signals.length - 1],
      postCount: () => streams.length,
    };
  }

  it("passes an AbortSignal to the send request so the server can be hung up on", async () => {
    const { latestSignal } = stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      void result.current.send("進捗を教えて");
    });
    await waitFor(() => expect(latestSignal()).toBeInstanceOf(AbortSignal));
    expect(latestSignal()?.aborted).toBe(false);

    act(() => result.current.stop());
    expect(latestSignal()?.aborted).toBe(true);
  });

  it("keeps the text delivered so far as an interrupted boss reply and clears the streaming buffer", async () => {
    const { latestStream, postCount } = stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      void result.current.send("進捗を教えて");
    });
    await waitFor(() => expect(postCount()).toBe(1));
    latestStream().push('event: text\ndata: {"text":"まずは見積"}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe("まずは見積"));

    act(() => result.current.stop());

    await waitFor(() =>
      expect(
        result.current.entries.some(
          (entry) =>
            entry.kind === "message" &&
            entry.role === "boss" &&
            entry.content === "まずは見積" &&
            entry.interrupted === true,
        ),
      ).toBe(true),
    );
    expect(result.current.streamingText).toBe("");
  });

  it("does not append a boss reply when nothing had been delivered yet", async () => {
    stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      void result.current.send("やっぱりやめます");
    });
    await waitFor(() => expect(result.current.sending).toBe(true));

    act(() => result.current.stop());

    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(
      result.current.entries.some(
        (entry) => entry.kind === "message" && entry.role === "boss",
      ),
    ).toBe(false);
  });

  it("does not surface an error: stopping is something the user asked for, not a failure", async () => {
    const { latestStream, postCount } = stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      void result.current.send("進捗を教えて");
    });
    await waitFor(() => expect(postCount()).toBe(1));
    latestStream().push('event: text\ndata: {"text":"考え中"}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe("考え中"));

    act(() => result.current.stop());

    await waitFor(() => expect(result.current.sending).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("releases the in-flight guard so the next send goes through normally", async () => {
    const { latestStream, postCount } = stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      void result.current.send("最初の相談");
    });
    await waitFor(() => expect(postCount()).toBe(1));
    latestStream().push('event: text\ndata: {"text":"途中"}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe("途中"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.sending).toBe(false));

    act(() => {
      void result.current.send("次の相談");
    });

    // 停止直後の送信がガードに弾かれず、実際にリクエストが飛び、
    // 送信中の状態に入る。
    await waitFor(() => expect(postCount()).toBe(2));
    expect(result.current.sending).toBe(true);

    // 2 本目は 1 本目とは別のストリームなので、独立して配信を受けられる。
    latestStream().push('event: text\ndata: {"text":"新しい応答"}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe("新しい応答"));
  });

  it("does nothing when called while no reply is being generated", async () => {
    stubFetchForStop();
    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const entriesBefore = result.current.entries;
    act(() => result.current.stop());

    expect(result.current.sending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.entries).toBe(entriesBefore);
  });
});

describe("useChat mount restoration (Issue #93: surviving a tab switch/reload)", () => {
  it("restores today's open morning session as active on mount and shows the whole day's timeline", async () => {
    const fetchMock = routedFetch({
      sessions: [MORNING_SESSION_TODAY, SESSION],
      messages: { 20: MORNING_HISTORY, 1: HISTORY },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessionType).toBe("morning");
    // Issue #272: both sessions' messages are shown in one chronological
    // timeline (the 08:00 morning meeting, then the 09:00 adhoc chat), with
    // the meeting's start boundary in place — the adhoc conversation is no
    // longer swapped out (AC-9/AC-12).
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
    ]);
    expect(requestedUrls(fetchMock)).toEqual([
      "/api/sessions",
      "/api/sessions/20/messages",
      "/api/sessions/1/messages",
    ]);
  });

  // AC-10
  it("keeps the meeting's messages on screen when ending a meeting that was restored on mount", async () => {
    const fetchMock = routedFetch({
      sessions: [MORNING_SESSION_TODAY, SESSION],
      messages: { 20: MORNING_HISTORY, 1: HISTORY },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessionType).toBe("morning");

    await act(async () => {
      await result.current.endSession();
    });

    expect(requestedUrls(fetchMock)).toContain("/api/sessions/20/end");
    expect(result.current.sessionType).toBe("adhoc");
    // The morning conversation stays, now closed off by an end boundary
    // (routedFetch ends sessions at 13:00 local, after every fixture).
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
      {
        kind: "boundary",
        key: "boundary-20-end",
        sessionType: "morning",
        event: "end",
      },
    ]);
  });

  it("treats an already-ended morning session as inactive but still shows it in the timeline", async () => {
    const endedMorning = { ...MORNING_SESSION_TODAY, ended_at: localIso(5, 8, 30) };
    const fetchMock = routedFetch({
      sessions: [endedMorning, SESSION],
      messages: { 20: MORNING_HISTORY, 1: HISTORY },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessionType).toBe("adhoc");
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
      {
        kind: "boundary",
        key: "boundary-20-end",
        sessionType: "morning",
        event: "end",
      },
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
    ]);
  });

  // AC-13: ADR 0007 決定4 で日跨ぎの夕会は開始日に帰属するため、23:50 開始の
  // 夕会は 00:30 時点で「当日」から外れる。補正が無いと、会を終了した瞬間に
  // その会の会話が画面から消える。
  it("keeps a meeting that started before midnight on screen when it is ended after the day rolls over", async () => {
    const crossMidnightEvening: ChatSession = {
      id: 40,
      type: "evening",
      started_at: localIso(4, 23, 50),
      ended_at: null,
      summary: null,
    };
    const eveningHistory: ChatMessage[] = [
      {
        id: 50,
        session_id: 40,
        role: "user",
        content: "今日の進捗です",
        interrupted: 0,
        created_at: localIso(4, 23, 55),
      },
    ];
    // Mount while it is still the meeting's own local day...
    vi.setSystemTime(new Date(2026, 6, 4, 23, 55, 0));
    const fetchMock = routedFetch({
      sessions: [crossMidnightEvening],
      messages: { 40: eveningHistory },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessionType).toBe("evening");

    // ...then the clock rolls past midnight before the user ends the meeting.
    vi.setSystemTime(new Date(2026, 6, 5, 0, 30, 0));
    await act(async () => {
      await result.current.endSession();
    });

    expect(result.current.sessionType).toBe("adhoc");
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-40-start",
        sessionType: "evening",
        event: "start",
      },
      { kind: "message", key: "message-50", role: "user", content: "今日の進捗です" },
      {
        kind: "boundary",
        key: "boundary-40-end",
        sessionType: "evening",
        event: "end",
      },
    ]);
  });

  // AC-14
  it("excludes a previous day's ended session from the timeline", async () => {
    const yesterdayEnded: ChatSession = {
      ...MORNING_SESSION_YESTERDAY,
      ended_at: localIso(4, 9),
    };
    const fetchMock = routedFetch({
      sessions: [yesterdayEnded, SESSION],
      messages: { 19: MORNING_HISTORY, 1: HISTORY },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(requestedUrls(fetchMock)).not.toContain("/api/sessions/19/messages");
    expect(result.current.entries).toEqual([
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
    ]);
  });

  it("does not restore a morning session from a previous day on mount", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([MORNING_SESSION_YESTERDAY]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.sessionType).toBe("adhoc");
    expect(result.current.entries).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("useChat session switching", () => {
  it("creates a new morning session when none exists for today", async () => {
    const fetchMock = routedFetch({
      sessions: [],
      created: MORNING_SESSION_TODAY,
      messages: { 20: [MORNING_OPENING_MESSAGE] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
    expect(requestedUrls(fetchMock)).toContain("/api/sessions/20/messages");
    expect(result.current.sessionType).toBe("morning");
    // The Issue #271 opening line is visible without the user having to send
    // anything first (AC-1/AC-2), below the meeting's start boundary.
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      {
        kind: "message",
        key: "message-31",
        role: "boss",
        content: "今日はA案件から片付けろ。",
      },
    ]);
    expect(result.current.switching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("resumes today's existing morning session instead of creating a new one", async () => {
    const fetchMock = routedFetch({
      sessions: [MORNING_SESSION_TODAY],
      messages: { 20: MORNING_HISTORY },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.sessionType).toBe("morning");
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
    ]);
  });

  it("ignores a morning session from a previous day and creates a new one", async () => {
    const fetchMock = routedFetch({
      sessions: [MORNING_SESSION_YESTERDAY],
      created: MORNING_SESSION_TODAY,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
    // Yesterday's session is not merged in (AC-14); only the new meeting's
    // start boundary shows.
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
    ]);
  });

  it("surfaces an error when starting a session fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(result.current.error).toBe("network error");
    expect(result.current.switching).toBe(false);
    expect(result.current.sessionType).toBe("adhoc");
  });

  it("does not update state after unmounting mid session switch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveSessions: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSessions = resolve;
          }),
      ) // startSession: kept pending until after unmount
      .mockResolvedValueOnce(jsonResponse([])); // messages of the found session
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.startSession("morning");
    });
    unmount();

    resolveSessions(jsonResponse([MORNING_SESSION_TODAY]));
    await act(async () => {
      await pending;
    });

    const actWarnings = errorSpy.mock.calls.filter(([first]) =>
      String(first).includes("not wrapped in act"),
    );
    expect(actWarnings).toEqual([]);
    errorSpy.mockRestore();
  });

  // AC-9/AC-10: 会の開始でも終了でも、直前までの会話が画面から消えない。
  it("keeps the adhoc conversation on screen across starting and ending a meeting", async () => {
    // A meeting started now, i.e. after the 09:00 adhoc conversation — unlike
    // the shared MORNING_SESSION_TODAY fixture, which is anchored at 08:00.
    const startedNow: ChatSession = {
      ...MORNING_SESSION_TODAY,
      started_at: localIso(5, 12),
    };
    const meetingHistory: ChatMessage[] = [
      {
        id: 30,
        session_id: 20,
        role: "user",
        content: "今日の予定です",
        interrupted: 0,
        created_at: localIso(5, 12, 1),
      },
    ];
    const fetchMock = routedFetch({
      sessions: [SESSION],
      created: startedNow,
      messages: { 1: HISTORY, 20: meetingHistory },
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });
    expect(result.current.sessionType).toBe("morning");
    // AC-9: the adhoc history is still there, above the start boundary.
    expect(result.current.entries.slice(0, 3)).toEqual([
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
    ]);

    await act(async () => {
      await result.current.endSession();
    });

    expect(requestedUrls(fetchMock)).toContain("/api/sessions/20/end");
    expect(result.current.sessionType).toBe("adhoc");
    // AC-10: the meeting's own messages stay too, now bracketed by boundaries.
    expect(result.current.entries).toEqual([
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
      {
        kind: "boundary",
        key: "boundary-20-end",
        sessionType: "morning",
        event: "end",
      },
    ]);
  });

  // 判断8: 表示は統一されても、送信先セッションの規則は変えない。
  it("sends to the adhoc session again after ending a morning session", async () => {
    const fetchMock = routedFetch({
      sessions: [SESSION],
      created: MORNING_SESSION_TODAY,
      messages: { 1: HISTORY },
      stream: sseResponse([`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });
    await act(async () => {
      await result.current.endSession();
    });
    await act(async () => {
      await result.current.send("続きの相談です");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("has no adhoc session to send to when there was none before switching", async () => {
    const fetchMock = routedFetch({
      sessions: [],
      created: MORNING_SESSION_TODAY,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });
    await act(async () => {
      await result.current.endSession();
    });

    expect(result.current.sessionType).toBe("adhoc");
    // The meeting itself is still on screen (AC-10) — what is empty is the
    // adhoc conversation, which `send` will create lazily.
    expect(result.current.entries).toEqual([
      {
        kind: "boundary",
        key: "boundary-20-start",
        sessionType: "morning",
        event: "start",
      },
      {
        kind: "boundary",
        key: "boundary-20-end",
        sessionType: "morning",
        event: "end",
      },
    ]);
  });

  it("surfaces an error when ending a session fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201))
      .mockResolvedValueOnce(jsonResponse([])) // Issue #271: opening-line re-fetch (none generated)
      .mockRejectedValueOnce(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });
    await act(async () => {
      await result.current.endSession();
    });

    expect(result.current.error).toBe("network error");
    expect(result.current.switching).toBe(false);
    // The session stays active on failure so the user isn't silently
    // dropped out of an unended session.
    expect(result.current.sessionType).toBe("morning");
  });

  it("ignores a second startSession call while one is already in flight", async () => {
    let resolveList: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveList = resolve; }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let first: Promise<void>;
    act(() => {
      first = result.current.startSession("morning");
    });
    await act(async () => {
      await result.current.startSession("morning");
    });

    // Only the mount fetch + the first startSession's list lookup ran; the
    // second call was ignored while the first was still in flight.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveList(jsonResponse(MORNING_SESSION_TODAY, 201));
    await act(async () => {
      await first;
    });
  });

  it("ignores startSession while a message send is in flight", async () => {
    let resolvePost: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolvePost = resolve; }),
      ); // createSession("adhoc") pending
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let sendPromise: Promise<void>;
    act(() => {
      sendPromise = result.current.send("送信中に切替を試みる");
    });
    await act(async () => {
      await result.current.startSession("morning");
    });

    // startSession must not have issued a request while sending is in
    // flight, and the session type stays adhoc.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.sessionType).toBe("adhoc");

    resolvePost(jsonResponse(SESSION, 201));
    await act(async () => {
      await sendPromise;
    });
  });

  it("ignores send while a session switch is in flight", async () => {
    let resolveList: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveList = resolve; }),
      ); // startSession's list lookup pending
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let switchPromise: Promise<void>;
    act(() => {
      switchPromise = result.current.startSession("morning");
    });
    await act(async () => {
      await result.current.send("切替中に送信を試みる");
    });

    // send() must not have appended anything or issued a request while the
    // switch is in flight.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.entries).toEqual([]);

    resolveList(jsonResponse(MORNING_SESSION_TODAY, 201));
    await act(async () => {
      await switchPromise;
    });
  });
});
