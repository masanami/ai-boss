import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

/**
 * クライアント切断で生成が実際に止まることを、**実 HTTP サーバ**に対して
 * 固定するテスト（#254）。
 *
 * このファイルが別に存在する理由: 同じルートの他のテストは Hono の
 * `app.request()` を使っており、あれは fetch ハンドラを直接呼ぶだけなので
 * **切断の配線をまったく通らない**。停止機能が依存しているのは、
 * `@hono/node-server` が接続断を検知して `c.req.raw.signal` を abort する
 * という Node アダプタ側の振る舞いであり、そこは `app.request()` の外にある。
 *
 * そしてこの配線は**黙って壊れうる**: Hono / `@hono/node-server` の更新で
 * 切断検知の経路が変わっても、`StreamingApi.write` は書き込みエラーを握り潰す
 * ため例外は出ず、「止めたのに LLM が走り続ける」状態へ静かに戻るだけである。
 * 例外もログも出ない以上、これを捕まえられるのはこのテストだけなので、
 * 実サーバを立てる価値がある。
 */

const { createClaudeClientMock, streamBossMessageMock, createBossMessageMock } = vi.hoisted(
  () => ({
    createClaudeClientMock: vi.fn(),
    streamBossMessageMock: vi.fn(),
    createBossMessageMock: vi.fn(),
  }),
);

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
    createBossMessage: createBossMessageMock,
  };
});

const { createApp } = await import("../app.js");

interface StreamBossMessageCallbacks {
  onTextDelta?: (delta: string) => void;
}

describe("POST /api/sessions/:id/messages — client disconnect over a real HTTP server (#254)", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    createBossMessageMock.mockResolvedValue({ content: [] });

    const app = createApp(db, env);
    server = await new Promise((resolve) => {
      // port 0 = エフェメラルポート（並列実行と衝突しない）。
      const started = serve({ fetch: app.fetch, port: 0 }, () => resolve(started));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  async function createSession(): Promise<Session> {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adhoc" }),
    });
    return (await res.json()) as Session;
  }

  function messagesOf(sessionId: number): Message[] {
    return db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as Message[];
  }

  /**
   * ボスの生成を模したハンドラ。最初のデルタを配信したあと、渡された signal が
   * abort されるまで待ち、abort されたら中断として reject する（実バックエンド
   * が signal を受けて打ち切る挙動の代役）。
   */
  function respondThenWaitForAbort(firstDelta: string): {
    firstDeltaSent: Promise<void>;
    abortObserved: Promise<void>;
  } {
    let resolveFirstDelta: () => void;
    let resolveAbortObserved: () => void;
    const firstDeltaSent = new Promise<void>((resolve) => {
      resolveFirstDelta = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbortObserved = resolve;
    });

    streamBossMessageMock.mockImplementationOnce(
      (
        _client: unknown,
        _request: unknown,
        callbacks: StreamBossMessageCallbacks,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          callbacks.onTextDelta?.(firstDelta);
          resolveFirstDelta();
          const signal = options?.signal;
          if (signal === undefined) {
            reject(new Error("no signal was handed to streamBossMessage"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              resolveAbortObserved();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    return { firstDeltaSent, abortObserved };
  }

  it("aborts the signal handed to the LLM call, and persists the delivered text as interrupted, when the client hangs up mid-stream", async () => {
    const session = await createSession();
    const { firstDeltaSent, abortObserved } = respondThenWaitForAbort("ここまでは届いた");

    const controller = new AbortController();
    const request = fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "誤送信しました" }),
      signal: controller.signal,
    }).then(async (res) => {
      // レスポンスボディを読み始めないと Node はソケットを開いたままにしない。
      const reader = res.body!.getReader();
      await reader.read();
      return reader;
    });

    await firstDeltaSent;
    await request.catch(() => undefined);

    // ここが本題: クライアントが切ると、サーバ側の LLM 呼び出しへ渡した
    // signal が abort される（＝呼びっぱなしにならない）。
    controller.abort();
    await abortObserved;

    // 永続化は切断後に走るので、DB へ書き終わるのを待つ。
    await vi.waitFor(() => {
      expect(messagesOf(session.id)).toHaveLength(2);
    });

    const messages = messagesOf(session.id);
    // ユーザーの発言は残る（実際に送ったため）。
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("誤送信しました");
    // そこまで届いた部分応答が、中断された形で残る。
    expect(messages[1].role).toBe("boss");
    expect(messages[1].content).toBe("ここまでは届いた");
    expect(messages[1].interrupted).toBe(1);
  });

  it("keeps the chat_message activity event when the client hangs up mid-stream", async () => {
    const session = await createSession();
    const { firstDeltaSent, abortObserved } = respondThenWaitForAbort("途中まで");

    const controller = new AbortController();
    const request = fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body!.getReader();
      await reader.read();
      return reader;
    });

    await firstDeltaSent;
    await request.catch(() => undefined);
    controller.abort();
    await abortObserved;

    const events = db
      .prepare("SELECT type FROM activity_events")
      .all() as { type: string }[];
    expect(events.map((e) => e.type)).toContain("chat_message");
  });

  it("does not persist a boss message when the client hangs up before any text was delivered", async () => {
    const session = await createSession();
    let resolveAbortObserved: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbortObserved = resolve;
    });
    // テキストを 1 文字も配信しないまま中断されるケース。
    streamBossMessageMock.mockImplementationOnce(
      (
        _client: unknown,
        _request: unknown,
        _callbacks: StreamBossMessageCallbacks,
        options?: { signal?: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              resolveAbortObserved();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );

    const controller = new AbortController();
    const request = fetch(`${baseUrl}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "やっぱりやめます" }),
      signal: controller.signal,
    }).then(async (res) => {
      const reader = res.body!.getReader();
      // 何も配信されないので read() は解決を待たない。
      void reader.read().catch(() => undefined);
      return reader;
    });

    await request.catch(() => undefined);
    controller.abort();
    await abortObserved;

    // 少し待っても boss 行は増えない（ユーザー発言だけが残る）。
    await vi.waitFor(() => {
      expect(messagesOf(session.id).length).toBeGreaterThanOrEqual(1);
    });
    const messages = messagesOf(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });
});
