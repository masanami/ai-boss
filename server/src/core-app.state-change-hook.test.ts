import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import type { StreamBossMessageCallbacks, StreamBossMessageOptions } from "./llm/claude-client.js";

const { createClaudeClientMock, streamBossMessageMock, toolGate } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
  /** 設定するとボスのツールの実行をその Promise の解決まで止める */
  toolGate: { hold: undefined as Promise<void> | undefined },
}));

vi.mock("./llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm/claude-client.js")>();
  return { ...actual, createClaudeClient: createClaudeClientMock, streamBossMessage: streamBossMessageMock };
});

vi.mock("./boss/boss-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boss/boss-tools.js")>();
  return {
    ...actual,
    executeBossTool: async (...args: Parameters<typeof actual.executeBossTool>) => {
      await toolGate.hold;
      return actual.executeBossTool(...args);
    },
  };
});

const { openDatabase } = await import("./db/connection.js");
const { runMigrations } = await import("./db/migrate.js");
const { portFor } = await import("./db/test-support/port-for.js");
const { createCoreApp } = await import("./core-app.js");

/**
 * WKWebView（製品版の実行環境）相当の `TransformStream`: Web 標準の
 * `Transformer` は `start`・`transform`・`flush` だけで、`cancel` は Node の
 * 拡張。渡されても呼ばない形にして、Node の拡張に頼らずに通知が来ることを示す。
 */
class TransformStreamWithoutCancel extends TransformStream {
  constructor(...args: ConstructorParameters<typeof TransformStream>) {
    const [transformer, ...strategies] = args;
    super(transformer && { ...transformer, cancel: undefined }, ...strategies);
  }
}

/**
 * `createCoreApp` の `onStateChangingRequest`（#585 S2）のうち、SSE で応答する
 * チャット（ボスのツールが応答を返した後のストリームの中で状態を変える）の
 * 扱い。LLM を模擬する必要があるため core-app.test.ts から分けた。
 */
describe("onStateChangingRequest with the SSE chat route", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    toolGate.hold = undefined;
    vi.stubGlobal("TransformStream", TransformStreamWithoutCancel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  /** 通知を受けた時点の DB の状態（タスクの件数・中断されたボスの発言の件数） */
  function snapshot() {
    return {
      tasks: (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c,
      interrupted: (
        db.prepare("SELECT COUNT(*) AS c FROM messages WHERE role = 'boss' AND interrupted = 1").get() as { c: number }
      ).c,
    };
  }

  /** マイクロタスクとタイマーの完了を流しきる */
  async function drainTasks(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function startSession(app: ReturnType<typeof createCoreApp>): Promise<number> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "adhoc" }),
    });
    return ((await res.json()) as { id: number }).id;
  }

  it("is called again when the SSE stream finishes (after the boss's tools could have changed state)", async () => {
    const notified: Array<ReturnType<typeof snapshot>> = [];
    const app = createCoreApp(portFor(db), {}, { onStateChangingRequest: () => notified.push(snapshot()) });
    const sessionId = await startSession(app);
    notified.length = 0;

    let finishLlm!: () => void;
    streamBossMessageMock.mockImplementation(
      async (_client: unknown, _request: unknown, callbacks: StreamBossMessageCallbacks) => {
        await callbacks.executeTool!("create_task", { title: "ボスが作ったタスク" });
        await new Promise<void>((resolve) => (finishLlm = resolve));
        return { content: [{ type: "text", text: "了解した", citations: null }] } as unknown as Anthropic.Message;
      },
    );

    const res = await app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = res.text();
    await vi.waitFor(() => expect(finishLlm).toBeDefined());
    expect(notified).toHaveLength(1);
    finishLlm();
    await body;
    await vi.waitFor(() => expect(notified).toHaveLength(2));
    expect(notified[1]!.tasks).toBe(1);
  });

  it("is called again after the stopped chat's cleanup, including DB writes that happen after the stop", async () => {
    const notified: Array<ReturnType<typeof snapshot>> = [];
    const app = createCoreApp(portFor(db), {}, { onStateChangingRequest: () => notified.push(snapshot()) });
    const sessionId = await startSession(app);
    notified.length = 0;

    // 止めた時点でボスのツールが実行中（claude-code バックエンドは生成の中止が
    // ツールの完了を待たない）: その書き込みは中止の後に起きる
    let releaseTool!: () => void;
    toolGate.hold = new Promise<void>((resolve) => (releaseTool = resolve));
    streamBossMessageMock.mockImplementation(
      (
        _client: unknown,
        _request: unknown,
        callbacks: StreamBossMessageCallbacks,
        options: StreamBossMessageOptions,
      ) => {
        callbacks.onTextDelta!("途中まで");
        void callbacks.executeTool!("create_task", { title: "止めた後にできるタスク" });
        return new Promise((_resolve, reject) =>
          options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    );

    const controller = new AbortController();
    const res = await app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(streamBossMessageMock).toHaveBeenCalled());
    expect(notified).toHaveLength(1);

    // 停止ボタン: 要求を中止し、応答のストリームを読むのをやめる
    controller.abort();
    await res.body!.cancel();
    await vi.waitFor(() => expect(snapshot().interrupted).toBe(1));
    // 中断メッセージの保存の後の後始末（ルートの残り）まで流しきってから確かめる
    await drainTasks();
    expect(notified).toHaveLength(1);

    releaseTool();
    await vi.waitFor(() => expect(notified).toHaveLength(2));
    expect(notified[1]).toEqual({ tasks: 1, interrupted: 1 });
  });
});
