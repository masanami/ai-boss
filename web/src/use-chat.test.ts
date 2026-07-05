import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChat } from "./use-chat";
import type { ChatMessage, ChatSession } from "./chat";

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
  content: "その相談なら B 案件を後回しにしろ。",
  created_at: "2026-07-05T10:00:00.000Z",
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

afterEach(() => {
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
});
