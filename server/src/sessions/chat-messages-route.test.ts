import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { listTasks } from "../tasks/tasks-repository.js";
import { listDecisions } from "../decisions/decisions-repository.js";
import { updateSessionSummary } from "./sessions-repository.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

const { createClaudeClientMock, streamBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
  };
});

const { createApp } = await import("../app.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

interface ErrorBody {
  error: string;
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseEvents(raw: string): SseEvent[] {
  return raw
    .trim()
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLines = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : "message",
        data: dataLines.join("\n"),
      };
    });
}

interface FakeBossLlmMessage {
  content: unknown[];
}

interface StreamBossMessageCallbacks {
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (event: {
    name: string;
    input: unknown;
    result: string;
    isError: boolean;
  }) => void | Promise<void>;
  executeTool?: (
    name: string,
    input: unknown,
  ) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }>;
}

function fakeTextMessage(text: string): FakeBossLlmMessage {
  return {
    content: text ? [{ type: "text", text }] : [],
  };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("POST /api/sessions/:id/messages", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  async function createSession(): Promise<Session> {
    const app = createApp(db, env);
    return readJson<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "adhoc" }),
      }),
    );
  }

  it("returns 404 for a non-existent session id", async () => {
    const app = createApp(db, env);

    const res = await app.request("/api/sessions/9999/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  it("returns 400 when content is missing", async () => {
    const session = await createSession();
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  it("defaults to the api backend when no llmBackend option is passed to createApp", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.find((e) => e.event === "done")).toBeDefined();

    expect(createClaudeClientMock).toHaveBeenCalledWith(env, "api");
  });

  it("passes the configured llmBackend (loadConfig 由来) through to createClaudeClient", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env, { llmBackend: "claude-code" });

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.find((e) => e.event === "done")).toBeDefined();

    expect(createClaudeClientMock).toHaveBeenCalledWith(env, "claude-code");
  });

  it("returns 500 JSON without leaking the api key when the Claude client cannot be created", async () => {
    const session = await createSession();
    createClaudeClientMock.mockImplementationOnce(() => {
      throw new MissingApiKeyError();
    });
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });

    expect(res.status).toBe(500);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toContain(env.ANTHROPIC_API_KEY);
  });

  it("persists the user message and records a chat_message activity event before streaming", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "資料作成から始めます" }),
    });
    await res.text();

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(session.id) as Message[];
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "資料作成から始めます",
    });

    const events = db.prepare("SELECT * FROM activity_events").all() as Array<{
      type: string;
    }>;
    expect(events.map((e) => e.type)).toContain("chat_message");
  });

  it("streams text deltas and a final done event with the persisted boss message", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("今日は");
        callbacks.onTextDelta?.("資料作成からだ");
        return fakeTextMessage("今日は資料作成からだ");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何から始めればいい？" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await res.text());

    const textEvents = events.filter((e) => e.event === "text");
    expect(textEvents.map((e) => JSON.parse(e.data).text)).toEqual([
      "今日は",
      "資料作成からだ",
    ]);

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage).toMatchObject({
      session_id: session.id,
      role: "boss",
      content: "今日は資料作成からだ",
    });

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(session.id) as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "boss", content: "今日は資料作成からだ" });
  });

  it("builds the system prompt from persona settings/tasks and passes the two task tools", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "資料作成" }),
    });

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "進捗どうですか" }),
    });
    await res.text();

    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "claude-sonnet-5",
        system: expect.stringContaining("決定の形で断言する"),
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "create_task" }),
          expect.objectContaining({ name: "update_task" }),
          expect.objectContaining({ name: "record_decision" }),
        ]),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "進捗どうですか" }),
        ]),
      }),
      expect.objectContaining({
        onTextDelta: expect.any(Function),
        executeTool: expect.any(Function),
        onToolEvent: expect.any(Function),
      }),
    );
    expect(streamBossMessageMock.mock.calls[0][1].system).toContain("資料作成");
  });

  it("passes the session's type as sessionType so the system prompt reflects the morning flow guidance", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "morning" }),
      }),
    );
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日の予定を報告します" }),
    });
    await res.text();

    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: expect.stringContaining("朝会（計画セッション）"),
      }),
      expect.objectContaining({
        onTextDelta: expect.any(Function),
        executeTool: expect.any(Function),
        onToolEvent: expect.any(Function),
      }),
    );
  });

  it("AC-2: includes a saved session summary in the system prompt so the boss can refer to recent reports without re-explanation", async () => {
    const app = createApp(db, env);
    const priorSession = await readJson<Session>(
      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "morning" }),
      }),
    );
    updateSessionSummary(
      db,
      priorSession.id,
      "資料作成を最優先にし、13時までに終わらせることを決定した。",
    );
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "今日はどう進めればいい？" }),
    });
    await res.text();

    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        system: expect.stringContaining(
          "資料作成を最優先にし、13時までに終わらせることを決定した。",
        ),
      }),
      expect.anything(),
    );
  });

  it("executes a create_task tool call via the streamBossMessage callbacks, emits a tool event, and finalizes with the resulting text", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const result = await callbacks.executeTool!("create_task", { title: "資料作成" });
        await callbacks.onToolEvent?.({
          name: "create_task",
          input: { title: "資料作成" },
          result: result.content,
          isError: result.isError,
        });
        callbacks.onTextDelta?.("タスクを作成した");
        return fakeTextMessage("タスクを作成した");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "タスクを作って" }),
    });

    const events = parseSseEvents(await res.text());
    expect(streamBossMessageMock).toHaveBeenCalledTimes(1);

    const tasks = listTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "資料作成", status: "todo" });

    const toolEvent = events.find((e) => e.event === "tool");
    expect(toolEvent).toBeDefined();
    const toolPayload = JSON.parse(toolEvent!.data) as {
      name: string;
      isError: boolean;
      result: string;
    };
    expect(toolPayload.name).toBe("create_task");
    expect(toolPayload.isError).toBe(false);
    expect(JSON.parse(toolPayload.result)).toMatchObject({ title: "資料作成" });

    const doneEvent = events.find((e) => e.event === "done");
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("タスクを作成した");
  });

  it("executes a record_decision tool call via the streamBossMessage callbacks, persists it under the session's id, and emits a tool event", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const result = await callbacks.executeTool!("record_decision", {
          content: "資料作成を最優先にする",
        });
        await callbacks.onToolEvent?.({
          name: "record_decision",
          input: { content: "資料作成を最優先にする" },
          result: result.content,
          isError: result.isError,
        });
        callbacks.onTextDelta?.("そう決めた");
        return fakeTextMessage("そう決めた");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何を優先すべき？" }),
    });

    const events = parseSseEvents(await res.text());
    expect(streamBossMessageMock).toHaveBeenCalledTimes(1);

    const decisions = listDecisions(db);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      session_id: session.id,
      content: "資料作成を最優先にする",
      status: "active",
    });

    const toolEvent = events.find((e) => e.event === "tool");
    expect(toolEvent).toBeDefined();
    const toolPayload = JSON.parse(toolEvent!.data) as {
      name: string;
      isError: boolean;
      result: string;
    };
    expect(toolPayload.name).toBe("record_decision");
    expect(toolPayload.isError).toBe(false);
    expect(JSON.parse(toolPayload.result)).toMatchObject({
      content: "資料作成を最優先にする",
    });

    const doneEvent = events.find((e) => e.event === "done");
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("そう決めた");
  });

  it("marks the tool result as an error and does not persist a decision when record_decision content is missing", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const result = await callbacks.executeTool!("record_decision", {});
        await callbacks.onToolEvent?.({
          name: "record_decision",
          input: {},
          result: result.content,
          isError: result.isError,
        });
        return fakeTextMessage("わかった");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何か決めて" }),
    });

    const events = parseSseEvents(await res.text());
    const toolEvent = events.find((e) => e.event === "tool");
    const toolPayload = JSON.parse(toolEvent!.data) as { isError: boolean };
    expect(toolPayload.isError).toBe(true);
    expect(streamBossMessageMock).toHaveBeenCalledTimes(1);
    expect(listDecisions(db)).toHaveLength(0);
  });

  it("marks the tool result as an error and still finalizes when the tool call is invalid", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const result = await callbacks.executeTool!("update_task", {
          id: 9999,
          priority: "high",
        });
        await callbacks.onToolEvent?.({
          name: "update_task",
          input: { id: 9999, priority: "high" },
          result: result.content,
          isError: result.isError,
        });
        return fakeTextMessage("わかった");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "9999番のタスクの優先度を上げて" }),
    });

    const events = parseSseEvents(await res.text());
    const toolEvent = events.find((e) => e.event === "tool");
    const toolPayload = JSON.parse(toolEvent!.data) as { isError: boolean };
    expect(toolPayload.isError).toBe(true);
    expect(streamBossMessageMock).toHaveBeenCalledTimes(1);
  });

  it("persists a tool-summary fallback text (and reflects it in the done event) when tools ran but no text was streamed", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const result = await callbacks.executeTool!("create_task", { title: "無限タスク" });
        await callbacks.onToolEvent?.({
          name: "create_task",
          input: { title: "無限タスク" },
          result: result.content,
          isError: result.isError,
        });
        // No onTextDelta call at all — simulates the round-cap case where
        // the facade's tool loop exhausted MAX_TOOL_ROUNDS without ever
        // producing text (that loop itself is now tested in
        // claude-client.test.ts; this test only pins the route's own
        // buildFallbackText(toolSummaries) persistence/SSE contract).
        return fakeTextMessage("");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "タスクを作り続けて" }),
    });
    const events = parseSseEvents(await res.text());

    expect(listTasks(db)).toHaveLength(1);

    const doneEvent = events.find((e) => e.event === "done");
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe(
      "タスク「無限タスク」を作成した。詳細はタスクボードで確認してくれ。",
    );

    const persisted = db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'boss'")
      .all(session.id) as Message[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].content).toBe(bossMessage.content);
  });

  it("persists a generic fallback text when the response has neither text nor tool use", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage(""));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    const events = parseSseEvents(await res.text());

    const doneEvent = events.find((e) => e.event === "done");
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).not.toBe("");
  });

  it("persists the partial boss text when the stream fails midway", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementationOnce(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("途中までの応答");
        throw new Error("connection reset with request id xyz789");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
    });
    const rawBody = await res.text();
    const events = parseSseEvents(rawBody);

    expect(rawBody).not.toContain("xyz789");
    expect(events.find((e) => e.event === "error")).toBeDefined();

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(session.id) as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user", "boss"]);
    expect(messages[1].content).toBe("途中までの応答");
  });

  it("emits a sanitized SSE error event when the Claude call fails, without persisting a boss message", async () => {
    const session = await createSession();
    streamBossMessageMock.mockRejectedValue(
      new Error("connection reset by peer with request id abc123"),
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    const rawBody = await res.text();
    const events = parseSseEvents(rawBody);

    expect(rawBody).not.toContain("abc123");
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ?")
      .all(session.id) as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });
});
