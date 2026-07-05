import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { listTasks } from "../tasks/tasks-repository.js";
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

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

function fakeToolUseMessage(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    content: [{ type: "tool_use", id, name, input }],
  } as unknown as Anthropic.Message;
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
    streamBossMessageMock.mockImplementation(async (_client, _request, onTextDelta) => {
      onTextDelta?.("今日は");
      onTextDelta?.("資料作成からだ");
      return fakeTextMessage("今日は資料作成からだ");
    });
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
        ]),
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "進捗どうですか" }),
        ]),
      }),
      expect.any(Function),
    );
    expect(streamBossMessageMock.mock.calls[0][1].system).toContain("資料作成");
  });

  it("executes a create_task tool call, emits a tool event, and continues the conversation", async () => {
    const session = await createSession();
    streamBossMessageMock
      .mockImplementationOnce(async () =>
        fakeToolUseMessage("tool_1", "create_task", { title: "資料作成" }),
      )
      .mockImplementationOnce(async (_client, _request, onTextDelta) => {
        onTextDelta?.("タスクを作成した");
        return fakeTextMessage("タスクを作成した");
      });
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "タスクを作って" }),
    });

    const events = parseSseEvents(await res.text());
    expect(streamBossMessageMock).toHaveBeenCalledTimes(2);

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

    // second round's request must include the assistant tool_use turn and
    // the tool_result turn so Claude can see what happened
    const secondCallRequest = streamBossMessageMock.mock.calls[1][1];
    const roles = secondCallRequest.messages.map(
      (m: { role: string }) => m.role,
    );
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("marks the tool result as an error and still continues when the tool call is invalid", async () => {
    const session = await createSession();
    streamBossMessageMock
      .mockImplementationOnce(async () =>
        fakeToolUseMessage("tool_1", "update_task", { id: 9999, priority: "high" }),
      )
      .mockImplementationOnce(async () => fakeTextMessage("わかった"));
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
    expect(streamBossMessageMock).toHaveBeenCalledTimes(2);
  });

  it("stops after 5 rounds when Claude keeps requesting tool use, finalizing with the accumulated text", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(async () =>
      fakeToolUseMessage("tool_x", "create_task", { title: "無限タスク" }),
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "タスクを作り続けて" }),
    });
    const events = parseSseEvents(await res.text());

    expect(streamBossMessageMock).toHaveBeenCalledTimes(5);
    expect(listTasks(db)).toHaveLength(5);

    const doneEvent = events.find((e) => e.event === "done");
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("");
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
