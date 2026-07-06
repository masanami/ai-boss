import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChat } from "./use-chat";
import type { ChatMessage, ChatSession } from "./chat";

// Local-time anchors: `isSameLocalDay` compares local dates, so all
// "today"/"yesterday" session timestamps are derived from local-date
// constructors (not fixed UTC strings) to stay TZ-independent.
const LOCAL_NOW = new Date(2026, 6, 5, 12, 0, 0); // 2026-07-05 12:00 local
const localIso = (day: number, hour: number) =>
  new Date(2026, 6, day, hour, 0, 0).toISOString();

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
  content: "その相談なら B 案件を後回しにしろ。",
  created_at: "2026-07-05T10:00:00.000Z",
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
    created_at: "2026-07-05T00:05:00.000Z",
  },
];

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

describe("useChat session switching", () => {
  it("creates a new morning session when none exists for today", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockResolvedValueOnce(jsonResponse([])) // startSession: no morning session today
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201)); // create
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/sessions?type=morning");
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
    expect(result.current.sessionType).toBe("morning");
    expect(result.current.entries).toEqual([]);
    expect(result.current.switching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("restores today's existing morning session instead of creating a new one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockResolvedValueOnce(jsonResponse([MORNING_SESSION_TODAY]))
      .mockResolvedValueOnce(jsonResponse(MORNING_HISTORY));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/sessions/20/messages",
    );
    expect(result.current.sessionType).toBe("morning");
    expect(result.current.entries).toEqual([
      { kind: "message", key: "message-30", role: "user", content: "今日の予定です" },
    ]);
  });

  it("ignores a morning session from a previous day and creates a new one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([MORNING_SESSION_YESTERDAY]))
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
    expect(result.current.entries).toEqual([]);
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

  it("ends the current session and restores the adhoc conversation from before switching", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION])) // mount: restore today's adhoc
      .mockResolvedValueOnce(jsonResponse(HISTORY))
      .mockResolvedValueOnce(jsonResponse([])) // startSession: no morning session today
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201)) // create morning
      .mockResolvedValueOnce(jsonResponse({ ...MORNING_SESSION_TODAY, ended_at: "2026-07-05T01:00:00.000Z" })); // end
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useChat());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.startSession("morning");
    });
    expect(result.current.sessionType).toBe("morning");

    await act(async () => {
      await result.current.endSession();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/sessions/20/end", {
      method: "POST",
    });
    expect(result.current.sessionType).toBe("adhoc");
    expect(result.current.entries).toEqual([
      { kind: "message", key: "message-1", role: "user", content: "おはようございます" },
      { kind: "message", key: "message-2", role: "boss", content: "今日は A 案件からだ。" },
    ]);
  });

  it("reuses the restored adhoc session id after ending a morning session", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([SESSION])) // mount: restore today's adhoc (id 1)
      .mockResolvedValueOnce(jsonResponse(HISTORY))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201))
      .mockResolvedValueOnce(jsonResponse({ ...MORNING_SESSION_TODAY, ended_at: "2026-07-05T01:00:00.000Z" }))
      .mockResolvedValueOnce(
        sseResponse([`event: done\ndata: ${JSON.stringify(BOSS_REPLY)}\n\n`]),
      );
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/sessions/1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns to an empty adhoc conversation when there was none before switching", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([])) // mount: no adhoc session
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201))
      .mockResolvedValueOnce(jsonResponse({ ...MORNING_SESSION_TODAY, ended_at: "2026-07-05T01:00:00.000Z" }));
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
    expect(result.current.entries).toEqual([]);
  });

  it("surfaces an error when ending a session fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(MORNING_SESSION_TODAY, 201))
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
