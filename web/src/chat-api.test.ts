import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  endSession,
  fetchLatestSession,
  fetchSessionMessages,
  fetchSessions,
  sendChatMessage,
} from "./chat-api";
import type { ChatMessage, ChatSession, ChatToolEvent } from "./chat";

const SAMPLE_SESSION: ChatSession = {
  id: 1,
  type: "adhoc",
  started_at: "2026-07-05T09:00:00.000Z",
  ended_at: null,
  summary: null,
};

const BOSS_MESSAGE: ChatMessage = {
  id: 10,
  session_id: 1,
  role: "boss",
  content: "A案件から着手しろ。",
  interrupted: 0,
  created_at: "2026-07-05T09:00:05.000Z",
};

function sseResponse(chunks: string[]): {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array>;
} {
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

function collectHandlers() {
  return {
    onText: vi.fn(),
    onTool: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestSession", () => {
  it("returns the first session of the type-filtered list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([SAMPLE_SESSION, { ...SAMPLE_SESSION, id: 0 }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestSession("adhoc")).resolves.toEqual(SAMPLE_SESSION);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions?type=adhoc");
  });

  it("filters by the given session type", async () => {
    const morningSession: ChatSession = { ...SAMPLE_SESSION, type: "morning" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([morningSession]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestSession("morning")).resolves.toEqual(morningSession);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions?type=morning");
  });

  it("returns null when no session of the given type exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      }),
    );

    await expect(fetchLatestSession("adhoc")).resolves.toBeNull();
  });

  it("throws the server-provided error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "invalid type" }),
      }),
    );

    await expect(fetchLatestSession("adhoc")).rejects.toThrow("invalid type");
  });
});

describe("fetchSessions", () => {
  it("fetches the unfiltered session list", async () => {
    const morningSession: ChatSession = { ...SAMPLE_SESSION, id: 2, type: "morning" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([morningSession, SAMPLE_SESSION]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSessions()).resolves.toEqual([morningSession, SAMPLE_SESSION]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions");
  });

  it("throws the server-provided error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "database is locked" }),
      }),
    );

    await expect(fetchSessions()).rejects.toThrow("database is locked");
  });
});

describe("createSession", () => {
  it("POSTs an adhoc session and returns the created record", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(SAMPLE_SESSION),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("adhoc")).resolves.toEqual(SAMPLE_SESSION);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adhoc" }),
    });
  });

  it("POSTs a morning session when requested", async () => {
    const morningSession: ChatSession = { ...SAMPLE_SESSION, type: "morning" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve(morningSession),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createSession("morning")).resolves.toEqual(morningSession);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "morning" }),
    });
  });
});

describe("endSession", () => {
  it("POSTs to the session's /end endpoint and returns the updated record", async () => {
    const endedSession: ChatSession = {
      ...SAMPLE_SESSION,
      ended_at: "2026-07-05T10:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(endedSession),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(endSession(1)).resolves.toEqual(endedSession);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/1/end", {
      method: "POST",
    });
  });

  it("throws the server-provided error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "session 99 not found" }),
      }),
    );

    await expect(endSession(99)).rejects.toThrow("session 99 not found");
  });
});

describe("fetchSessionMessages", () => {
  it("fetches the message history of the given session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([BOSS_MESSAGE]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSessionMessages(1)).resolves.toEqual([BOSS_MESSAGE]);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/1/messages");
  });

  it("throws when the session does not exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "session 99 not found" }),
      }),
    );

    await expect(fetchSessionMessages(99)).rejects.toThrow(
      "session 99 not found",
    );
  });
});

describe("sendChatMessage", () => {
  it("POSTs the content and dispatches text deltas then done", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: text\ndata: {"text":"A案件"}\n\n',
        'event: text\ndata: {"text":"から着手しろ。"}\n\n',
        `event: done\ndata: ${JSON.stringify(BOSS_MESSAGE)}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = collectHandlers();

    await sendChatMessage(1, "どれからやる？", handlers);

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "どれからやる？" }),
    });
    expect(handlers.onText.mock.calls.map(([delta]) => delta)).toEqual([
      "A案件",
      "から着手しろ。",
    ]);
    expect(handlers.onDone).toHaveBeenCalledWith(BOSS_MESSAGE);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it("parses events split across chunk boundaries", async () => {
    const whole = 'event: text\ndata: {"text":"分割された応答"}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([whole.slice(0, 18), whole.slice(18)]));
    vi.stubGlobal("fetch", fetchMock);
    const handlers = collectHandlers();

    await sendChatMessage(1, "テスト", handlers);

    expect(handlers.onText).toHaveBeenCalledWith("分割された応答");
  });

  it("dispatches tool events", async () => {
    const toolEvent: ChatToolEvent = {
      name: "create_task",
      input: { title: "資料作成" },
      result: JSON.stringify({ id: 3, title: "資料作成" }),
      isError: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        `event: tool\ndata: ${JSON.stringify(toolEvent)}\n\n`,
        `event: done\ndata: ${JSON.stringify(BOSS_MESSAGE)}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = collectHandlers();

    await sendChatMessage(1, "タスク化して", handlers);

    expect(handlers.onTool).toHaveBeenCalledWith(toolEvent);
  });

  it("dispatches error events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'event: error\ndata: {"error":"ボスの応答中にエラーが発生しました"}\n\n',
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = collectHandlers();

    await sendChatMessage(1, "テスト", handlers);

    expect(handlers.onError).toHaveBeenCalledWith(
      "ボスの応答中にエラーが発生しました",
    );
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it("reports malformed event data via onError instead of rejecting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        "event: text\ndata: {broken json\n\n",
        `event: done\ndata: ${JSON.stringify(BOSS_MESSAGE)}\n\n`,
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = collectHandlers();

    await expect(sendChatMessage(1, "テスト", handlers)).resolves.toBeUndefined();

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it("throws the server error before streaming when the request is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: "session 99 not found" }),
        body: null,
      }),
    );
    const handlers = collectHandlers();

    await expect(sendChatMessage(99, "テスト", handlers)).rejects.toThrow(
      "session 99 not found",
    );
    expect(handlers.onText).not.toHaveBeenCalled();
  });
});
