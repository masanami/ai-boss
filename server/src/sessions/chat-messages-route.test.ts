import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask, listTasks } from "../tasks/tasks-repository.js";
import { listDecisions } from "../decisions/decisions-repository.js";
import { MENTORING_TARGET_TASK_INSTRUCTION } from "../boss/persona-prompt.js";
import { updateSessionSummary } from "./sessions-repository.js";
import { insertMessage } from "./messages-repository.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

const { createClaudeClientMock, streamBossMessageMock, createBossMessageMock } = vi.hoisted(
  () => ({
    createClaudeClientMock: vi.fn(),
    streamBossMessageMock: vi.fn(),
    // Issue #271: creating a morning/evening session now also triggers the
    // meeting-opening generator (`createBossMessage`), which this file
    // otherwise never exercises. Left unmocked, `createClaudeClientMock`'s
    // `{}` stub (no `.client`) would reach the real `api`-backend dispatch,
    // fail, and retry with real (non-faked) exponential backoff, adding
    // several seconds to every test that creates a morning/evening session.
    // Mocked purely to keep those calls fast — this file's own assertions
    // are about the chat message route, not the opening line's content.
    createBossMessageMock: vi.fn(),
  }),
);

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
    createBossMessage: createBossMessageMock,
  };
});

const { createApp } = await import("../app.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");

interface ErrorBody {
  error: string;
  code?: string;
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
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
    // Empty content -> meeting-opening's own "text === ''" branch -> its
    // fixed fallback text is persisted, without touching the retry path.
    createBossMessageMock.mockResolvedValue({ content: [] });
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

  // Issue #501: セッション不在 404 は 3 エンドポイントで同じ形に揃える。
  // ボディ全体を `code` と文言まで照合し、数値でない id も同じ応答であることを確かめる。
  it.each(["9999", "not-a-number"])(
    "returns 404 with code session_not_found for a non-existent session id (%s)",
    async (rawId) => {
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${rawId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "こんにちは" }),
      });

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(body).toEqual({
        error: "セッションが見つかりません",
        code: "session_not_found",
      });
      expect(streamBossMessageMock).not.toHaveBeenCalled();
    },
  );

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

  it("defaults to the claude-code backend (DEFAULT_LLM_BACKEND, Issue #118) when no llmBackend option is passed to createApp", async () => {
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

    expect(createClaudeClientMock).toHaveBeenCalledWith(env, "claude-code");
  });

  it("resolves the omitted llmBackend option from env, so an explicit LLM_BACKEND=api still reaches the api backend (Issue #118 — FR-12: no silent backend switch)", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const apiEnv = { ...env, LLM_BACKEND: "api" };
    const app = createApp(db, apiEnv);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.find((e) => e.event === "done")).toBeDefined();

    expect(createClaudeClientMock).toHaveBeenCalledWith(apiEnv, "api");
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

  // Issue #461（親 #446 S1）: docs/features/boss-reply-plain-text-output.md
  // クリティカル設計決定「SSE 送出の制約」— `done` の payload を組み立てる
  // 際に `content` を正規化した値へ差し替える。DB へ挿入する行は生のまま
  // （「保存 content の扱い」決定と両立させる）。
  it("AC-16/AC-13: normalizes the done event's content while leaving the persisted messages.content as the LLM's raw output", async () => {
    const session = await createSession();
    const rawFullText = "<p>今日は資料作成からだ</p><strong>優先しろ</strong>。";
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.(rawFullText);
        return fakeTextMessage(rawFullText);
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何から始めればいい？" }),
    });

    const events = parseSseEvents(await res.text());
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const bossMessage = JSON.parse(doneEvent!.data) as Message;
    expect(bossMessage.content).toBe("\n今日は資料作成からだ\n優先しろ。");

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(session.id) as Message[];
    expect(messages[1]).toMatchObject({ role: "boss", content: rawFullText });
  });

  // Issue #462（親 #446 S1）: docs/features/boss-reply-plain-text-output.md
  // クリティカル設計決定「SSE 送出の制約」— 正規化は累積文字列に対して行い、
  // タグの一部になりうる末尾は送出を保留する。ここで固定するのは
  // 「`text` 断片の連結 === `GET /api/sessions/:id/messages` の `content`」
  // という一致であり、ストリーミング中に見えたものと確定後に読み出したものが
  // 食い違わないことを意味する。
  describe.each([
    {
      name: "AC-14: a tag arriving split across several deltas",
      deltas: ["<", "p", ">", "今日は資料", "作成からだ", "</", "p", ">"],
      expected: "\n今日は資料作成からだ\n",
    },
    {
      name: "AC-14: an unclosed '<' that only later turns out to start a matching tag",
      // `"<a x <p"` の時点で「最後の `<`」で切ると `"<a x "` を送出して
      // しまうが、続く `">"` で全体が 1 個の `<a ...>` として一致し正規化
      // 結果は `"後半だけが残る"` になる——送出済みの 5 文字は撤回できない。
      // 保留の分割点が「最後の `<`」ではなく「最後の `>` より後の最初の `<`」
      // であることを固定する（`<` が 2 つ無いと 2 つの規則が区別できない）。
      deltas: ["<a x ", "<p", ">後半だけが残る"],
      expected: "後半だけが残る",
    },
    {
      name: "AC-15: a reply ending with an unclosed '<br'",
      deltas: ["まず資料作成だ", "<br"],
      expected: "まず資料作成だ<br",
    },
    {
      name: 'AC-15: a reply ending with an unclosed \'<div class="x"\'',
      deltas: ["<p>まず資料作成だ</p>", '<div class="x"'],
      expected: '\nまず資料作成だ\n<div class="x"',
    },
    {
      name: "AC-14: text containing '<' that never becomes a tag is streamed unchanged",
      deltas: ["x ", "< 10 のとき", "は待て"],
      expected: "x < 10 のときは待て",
    },
  ])("streaming/read consistency — $name", ({ deltas, expected }) => {
    it("concatenated text events equal the content read back from GET /messages", async () => {
      const session = await createSession();
      const rawFullText = deltas.join("");
      streamBossMessageMock.mockImplementation(
        async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
          for (const delta of deltas) {
            callbacks.onTextDelta?.(delta);
          }
          return fakeTextMessage(rawFullText);
        },
      );
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "何から始めればいい？" }),
      });

      const events = parseSseEvents(await res.text());
      const streamed = events
        .filter((e) => e.event === "text")
        .map((e) => (JSON.parse(e.data) as { text: string }).text)
        .join("");

      const readBack = await readJson<Message[]>(
        await app.request(`/api/sessions/${session.id}/messages`),
      );
      const bossMessage = readBack.find((m) => m.role === "boss");

      expect(bossMessage).toBeDefined();
      expect(streamed).toBe(bossMessage!.content);
      // 恒真化の防止: 一致すべき値そのものも固定する（両辺が揃って壊れても
      // 上の等値だけなら通ってしまうため）。
      expect(streamed).toBe(expected);
      // 保存値は LLM の生出力のまま（「保存 content の扱い」決定）。
      const stored = db
        .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'boss'")
        .get(session.id) as Message;
      expect(stored.content).toBe(rawFullText);
    });
  });

  // Codex 指摘（PR #467）: 許可リストのマークアップだけの応答は、正規化後に
  // 空白しか残らない。`fullText !== ""` で判定していると生の応答が選ばれ、
  // done も再読み込みも空白のみになる。判定を正規化後の結果に寄せる。
  it("falls back to the no-reply text when the LLM returns only allowlisted markup", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("<p></p><strong></strong>");
        return fakeTextMessage("<p></p><strong></strong>");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何から始めればいい？" }),
    });

    const events = parseSseEvents(await res.text());
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect((JSON.parse(doneEvent!.data) as Message).content).toBe(
      "応答を生成できなかった。もう一度送ってくれ。",
    );

    // 再読み込みでも同じ文面が出る（空白のみのメッセージが履歴に残らない）。
    const readBack = await readJson<Message[]>(
      await app.request(`/api/sessions/${session.id}/messages`),
    );
    expect(readBack.find((m) => m.role === "boss")!.content).toBe(
      "応答を生成できなかった。もう一度送ってくれ。",
    );
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

  // Issue #271 (AC-8): a meeting-opening line (role: "boss") persisted before
  // the first user message would otherwise put an "assistant" message first
  // in the request sent to the `api` backend, which Anthropic's Messages API
  // rejects outright. The `claude-code` backend never surfaces this (its
  // prompt builder flattens history into plain text instead), so this test
  // is the only guard against the normalization regressing — see
  // toClaudeMessages's own doc comment in chat-messages-route.ts.
  it("AC-8: drops a leading boss message (e.g. the meeting-opening line) so the request sent to streamBossMessage starts with role user", async () => {
    const session = await createSession();
    insertMessage(db, {
      session_id: session.id,
      role: "boss",
      content: "夕会が始まった。今日の進捗を報告しろ。",
    });
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "資料作成を進めています" }),
    });
    await res.text();

    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [{ role: "user", content: "資料作成を進めています" }],
      }),
      expect.anything(),
      // #254: 4 つ目の引数（停止用 signal）が加わった。既存アサーションは
      // 引数の個数まで固定するため、意図的な契約変更としてここも更新している。
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(streamBossMessageMock.mock.calls[0][1].system).toContain("資料作成");
  });

  // 機能仕様 docs/features/completion-evidence-enforcement.md 決定3-a
  it("includes the task's evidence requirement and attached-evidence count in the system prompt (AC-21/AC-22)", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const createRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "資料作成", evidence_required: true }),
    });
    const created = await readJson<{ id: number }>(createRes);
    await app.request(`/api/tasks/${created.id}/evidences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/report" }),
    });

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "進捗どうですか" }),
    });
    await res.text();

    const system = streamBossMessageMock.mock.calls[0][1].system as string;
    expect(system).toContain("必須");
    expect(system).toContain("1件");
  });

  // Issue #288: チャットは現在日時を「出す」側の経路。ラベルの有無だけを見る
  // （表記そのものの検証は persona-prompt.test.ts が持つ）。
  it("includes the current date/time section in the system prompt (#288)", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "いま何時ですか" }),
    });
    await res.text();

    expect(streamBossMessageMock.mock.calls[0][1].system).toContain("現在日時:");
  });

  // Issue #117: chat is the one call site that opts into thinking (see
  // chat-messages-route.ts's doc comment on the streamBossMessage call) —
  // pin the exact request shape so a future edit can't silently drop this
  // and regress into the "thinking-only turn exhausts max_tokens" bug.
  it("Issue #117: enables adaptive thinking with effort 'low' on the streamBossMessage request", async () => {
    const session = await createSession();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    await res.text();

    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        thinking: { type: "adaptive" },
        outputConfig: { effort: "low" },
      }),
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  // Issue #409（親 #276）: 「朝会 かつ 強制オン」または「リクエストの
  // mentoring」を 1 つの boolean に合成して buildPersonaPrompt へ渡す
  // （機能仕様「IF（境界となる契約）」）。合成そのものはこのルートの責務で、
  // buildPersonaPrompt 自体は純粋関数のまま（persona-prompt.test.ts で
  // 個別に担保済み）。
  describe("メンタリングの指示を積む条件の合成（Issue #409）", () => {
    async function createSessionOfType(
      type: "morning" | "evening" | "adhoc",
    ): Promise<Session> {
      const app = createApp(db, env);
      return readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        }),
      );
    }

    it("朝会・強制オン（既定）のとき、mentoring を指定しなくてもシステムプロンプトにメンタリングの指示が含まれる（AC-1）", async () => {
      const session = await createSessionOfType("morning");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "今日の予定を報告します" }),
      });
      await res.text();

      expect(streamBossMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          system: expect.stringContaining("record_mentoring"),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("朝会・強制オフに設定したとき、mentoring を指定しなければシステムプロンプトにメンタリングの指示が含まれない（AC-2）", async () => {
      const settingsApp = createApp(db, env);
      await settingsApp.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morning_mentoring_required: false }),
      });
      const session = await createSessionOfType("morning");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "今日の予定を報告します" }),
      });
      await res.text();

      expect(streamBossMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          system: expect.not.stringContaining("record_mentoring"),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("adhoc セッションで mentoring: true を送ると、システムプロンプトにメンタリングの指示が含まれる（AC-26）", async () => {
      const session = await createSessionOfType("adhoc");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "進め方を見てほしい", mentoring: true }),
      });
      await res.text();

      expect(streamBossMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          system: expect.stringContaining("record_mentoring"),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("adhoc セッションで mentoring を省略すると、システムプロンプトにメンタリングの指示が含まれない（AC-27）", async () => {
      const session = await createSessionOfType("adhoc");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "資料作成から始めます" }),
      });
      await res.text();

      expect(streamBossMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          system: expect.not.stringContaining("record_mentoring"),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("mentoring に boolean 以外を渡すと 400 が返り、streamBossMessage は呼ばれない（AC-28）", async () => {
      const session = await createSessionOfType("adhoc");
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "進め方を見てほしい", mentoring: "true" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("mentoring");
      expect(streamBossMessageMock).not.toHaveBeenCalled();
    });

    it("朝会・強制オフのセッションでも mentoring: true を明示すればメンタリングの指示が含まれる（OR 合成）", async () => {
      const settingsApp = createApp(db, env);
      await settingsApp.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morning_mentoring_required: false }),
      });
      const session = await createSessionOfType("morning");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "進め方を見てほしい", mentoring: true }),
      });
      await res.text();

      expect(streamBossMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          system: expect.stringContaining("record_mentoring"),
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("adhoc セッションで mentoring: true を送っても 400/404 にならない（判断1・6: サーバーはセッション種別で拒否しない）", async () => {
      const session = await createSessionOfType("adhoc");
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "進め方を見てほしい", mentoring: true }),
      });

      expect(res.status).toBe(200);
    });
  });

  // Issue #471（親 #444 決定7）: mentoringTaskId の受理・検証・配線。
  describe("mentoringTaskId（Issue #471, 親 #444 決定7）", () => {
    function countMessagesInSession(sessionId: number): number {
      return (
        db
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
          .get(sessionId) as { count: number }
      ).count;
    }

    it.each([
      ["a numeric string", "7"],
      ["zero", 0],
      ["a negative integer", -1],
      ["a decimal", 1.5],
      ["a boolean", true],
    ])(
      "returns 400 and does not persist the user message when mentoringTaskId is %s, even with mentoring: true (AC-12/AC-15)",
      async (_label, value) => {
        const session = await createSession();
        const app = createApp(db, env);

        const res = await app.request(`/api/sessions/${session.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "進め方を見てほしい",
            mentoring: true,
            mentoringTaskId: value,
          }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("mentoringTaskId");
        expect(streamBossMessageMock).not.toHaveBeenCalled();
        expect(countMessagesInSession(session.id)).toBe(0);
      },
    );

    it("returns 400 and does not persist the user message when mentoringTaskId is present without mentoring: true (AC-13/AC-15)", async () => {
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      const session = await createSession();
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "進め方を見てほしい",
          mentoringTaskId: task.id,
        }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("mentoringTaskId");
      expect(streamBossMessageMock).not.toHaveBeenCalled();
      expect(countMessagesInSession(session.id)).toBe(0);
    });

    // Issue #495: 404 の出どころ（セッション不在 404 との取り違え）を区別する
    // ため、ボディ全体を `code` と文言まで照合する。
    it("returns 404 with code mentoring_task_not_found and does not persist the user message when mentoringTaskId refers to a nonexistent task (AC-14/AC-15)", async () => {
      const session = await createSession();
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "進め方を見てほしい",
          mentoring: true,
          mentoringTaskId: 9999,
        }),
      });

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(body).toEqual({
        error: "対象のタスクが見つかりません",
        code: "mentoring_task_not_found",
      });
      expect(streamBossMessageMock).not.toHaveBeenCalled();
      expect(countMessagesInSession(session.id)).toBe(0);
    });

    it("wires a validated mentoringTaskId into buildPersonaPrompt, adding the 対象タスク section (結線の担保)", async () => {
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      const session = await createSession();
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "進め方を見てほしい",
          mentoring: true,
          mentoringTaskId: task.id,
        }),
      });
      await res.text();

      expect(res.status).toBe(200);
      const system = streamBossMessageMock.mock.calls[0][1].system as string;
      expect(system).toContain(MENTORING_TARGET_TASK_INSTRUCTION);
      expect(system).toContain("資料作成");
    });

    // セルフレビュー指摘: 対照群にもタスクを1件 insert し、「mentoringTaskId 省略
    // だから対象タスクセクションが無い」であって「tasks が空だから無い」の
    // 誤検出（`resolveMentoringTargetTask` は候補が無ければどのみち undefined
    // を返すため、tasks 空だとどんな実装でも緑になってしまう）を防ぐ。
    // 併せて MENTORING_FLOW_INSTRUCTION（"record_mentoring" を含む既存の
    // メンタリング指示。他のテストが同じ流儀で代理検証している）自体は
    // 積まれていることも確認し、mentoring ゲートごと壊れて全セクションが
    // 消えるケースを見逃さないようにする。
    it("does not add the 対象タスク section when mentoringTaskId is omitted, even with mentoring: true and an existing task (AC-16 非回帰)", async () => {
      insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      const session = await createSession();
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const app = createApp(db, env);

      const res = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "進め方を見てほしい", mentoring: true }),
      });
      await res.text();

      expect(res.status).toBe(200);
      const system = streamBossMessageMock.mock.calls[0][1].system as string;
      expect(system).toContain("record_mentoring");
      expect(system).not.toContain(MENTORING_TARGET_TASK_INSTRUCTION);
    });

    it("wires a validated mentoringTaskId into executeBossTool, filling record_mentoring's task_id fallback (結線の担保)", async () => {
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      const session = await createSession();
      streamBossMessageMock.mockImplementation(
        async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
          const result = await callbacks.executeTool!("record_mentoring", {
            content: "今のやり方のままで進める",
          });
          await callbacks.onToolEvent?.({
            name: "record_mentoring",
            input: { content: "今のやり方のままで進める" },
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
        body: JSON.stringify({
          content: "進め方を見てほしい",
          mentoring: true,
          mentoringTaskId: task.id,
        }),
      });
      await res.text();

      expect(res.status).toBe(200);
      const decisions = listDecisions(db);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({
        kind: "mentoring",
        task_id: task.id,
      });
    });
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  describe("当日の随時チャットの参考情報ブロック（#367 / 親 #270）", () => {
    const ADHOC_BLOCK_START = "---ADHOC-CHAT-START---";

    /**
     * 当日の随時セッションに1往復ぶんのメッセージを残す。`insertMessage` は
     * `created_at` に実行時刻をそのまま入れるため、当日ローカル暦日の窓に
     * 自然に収まる（固定日時を UTC 文字列で組まないので TZ 非依存）。
     */
    async function seedTodaysAdhocChat(): Promise<void> {
      const adhocSession = await createSession();
      insertMessage(db, {
        session_id: adhocSession.id,
        role: "user",
        content: "経費精算のことで相談したい",
      });
      insertMessage(db, {
        session_id: adhocSession.id,
        role: "boss",
        content: "経費精算は今日中に出せ。後回しにするな。",
      });
    }

    async function createMeetingSession(
      type: "morning" | "evening",
    ): Promise<Session> {
      const app = createApp(db, env);
      return readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        }),
      );
    }

    async function postMessage(sessionId: number): Promise<void> {
      const app = createApp(db, env);
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
      const res = await app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "報告します" }),
      });
      await res.text();
    }

    function lastSystemPrompt(): string {
      const calls = streamBossMessageMock.mock.calls;
      return (calls[calls.length - 1][1] as { system: string }).system;
    }

    it("朝会のシステムプロンプトに当日の随時チャットが参考情報として入る", async () => {
      await seedTodaysAdhocChat();
      const session = await createMeetingSession("morning");

      await postMessage(session.id);

      const system = lastSystemPrompt();
      expect(system).toContain(ADHOC_BLOCK_START);
      expect(system).toContain("経費精算のことで相談したい");
      expect(system).toContain("経費精算は今日中に出せ。後回しにするな。");
    });

    it("夕会のシステムプロンプトにも当日の随時チャットが参考情報として入る", async () => {
      await seedTodaysAdhocChat();
      const session = await createMeetingSession("evening");

      await postMessage(session.id);

      const system = lastSystemPrompt();
      expect(system).toContain(ADHOC_BLOCK_START);
      expect(system).toContain("経費精算のことで相談したい");
    });

    it("当日の随時チャットが無い日は参考情報ブロック自体がプロンプトに現れない", async () => {
      const session = await createMeetingSession("morning");

      await postMessage(session.id);

      const system = lastSystemPrompt();
      expect(system).not.toContain(ADHOC_BLOCK_START);
      expect(system).not.toContain("当日の随時チャット");
    });

    it("随時セッション自身のチャットでは参考情報ブロックを渡さない（会話履歴との二重計上を避ける）", async () => {
      await seedTodaysAdhocChat();
      const session = await createSession();

      await postMessage(session.id);

      const system = lastSystemPrompt();
      expect(system).not.toContain(ADHOC_BLOCK_START);
    });
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

  // GAP-10: the pre-existing SSE tests only ever check event *presence*
  // (`events.find((e) => e.event === "tool")`), so a regression that
  // reorders the stream (e.g. buffering text deltas instead of writing them
  // immediately) would sail through untouched. This test instead treats
  // `parseSseEvents`' return value as an ordered array and asserts the
  // relative *positions* of "text" / "tool" / "done" — see the mutation
  // check in this ticket's report for a production-side reorder this
  // catches that `.find()` alone would miss.
  it("AC-1 (GAP-10): orders SSE events as text -> tool -> done, verified by index rather than mere existence", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("資料作成から");
        const result = await callbacks.executeTool!("create_task", { title: "資料作成" });
        await callbacks.onToolEvent?.({
          name: "create_task",
          input: { title: "資料作成" },
          result: result.content,
          isError: result.isError,
        });
        callbacks.onTextDelta?.("始めよう");
        return fakeTextMessage("資料作成から始めよう");
      },
    );
    const app = createApp(db, env);

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "何をすべき？" }),
    });

    const events = parseSseEvents(await res.text());

    // Index each expected event by its own content (not just its type),
    // since the mock fires two "text" deltas around the tool call — a
    // by-type-only `indexOf` would only ever see the *first* "text" event
    // and could miss a regression that delays the tool event past the
    // *second* delta (still "before done", but no longer "before the second
    // text delta").
    const firstTextIndex = events.findIndex(
      (e) => e.event === "text" && JSON.parse(e.data).text === "資料作成から",
    );
    const toolIndex = events.findIndex((e) => e.event === "tool");
    const secondTextIndex = events.findIndex(
      (e) => e.event === "text" && JSON.parse(e.data).text === "始めよう",
    );
    const doneIndex = events.findIndex((e) => e.event === "done");

    expect(firstTextIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(secondTextIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    // Full index chain, not just "all four exist" — a regression that
    // delays the tool event's write (e.g. buffering it until just before
    // "done" instead of writing it as soon as the callback fires) fails
    // here even though "tool" still ends up before "done": it would land
    // after the second "text" delta too, which this chain also pins down.
    expect(firstTextIndex).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(secondTextIndex);
    expect(secondTextIndex).toBeLessThan(doneIndex);
  });

  // GAP-12: `activity_events` is the single input for the slacking-detection
  // rule engine (ADR 0004), so a turn that calls two tools must record
  // exactly one `task_update` row per real update — no drops (a silently
  // lost signal) and no duplicates (an inflated signal). The route itself
  // always records exactly one `chat_message` event before streaming starts
  // (L142 of chat-messages-route.ts), so that row is asserted separately
  // from the tool-driven `task_update` rows to keep the two signal sources
  // distinguishable.
  it("AC-3 (GAP-12): records exactly one activity_events row per tool-driven update when a turn calls two or more tools, with no duplicates or drops", async () => {
    const session = await createSession();
    const app = createApp(db, env);

    const taskA = await readJson<{ id: number }>(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "資料作成" }),
      }),
    );
    const taskB = await readJson<{ id: number }>(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "レビュー" }),
      }),
    );

    streamBossMessageMock.mockImplementation(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        const resultA = await callbacks.executeTool!("update_task", {
          id: taskA.id,
          priority: "high",
        });
        await callbacks.onToolEvent?.({
          name: "update_task",
          input: { id: taskA.id, priority: "high" },
          result: resultA.content,
          isError: resultA.isError,
        });
        const resultB = await callbacks.executeTool!("update_task", {
          id: taskB.id,
          priority: "low",
        });
        await callbacks.onToolEvent?.({
          name: "update_task",
          input: { id: taskB.id, priority: "low" },
          result: resultB.content,
          isError: resultB.isError,
        });
        callbacks.onTextDelta?.("両方の優先度を更新した");
        return fakeTextMessage("両方の優先度を更新した");
      },
    );

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "両方とも優先度を変えて" }),
    });
    await res.text();

    const events = db.prepare("SELECT * FROM activity_events").all() as Array<{
      type: string;
      task_id: number | null;
    }>;
    const chatMessageEvents = events.filter((e) => e.type === "chat_message");
    const taskUpdateEvents = events.filter((e) => e.type === "task_update");

    // The route's own `chat_message` record (recorded once, before any tool
    // runs) is counted separately from the two tool-driven `task_update`
    // records, so a bug that miscounts either source can't hide behind the
    // other's count.
    expect(chatMessageEvents).toHaveLength(1);
    expect(taskUpdateEvents).toHaveLength(2);
    expect(taskUpdateEvents.map((e) => e.task_id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      [taskA.id, taskB.id].sort((a, b) => a - b),
    );
    // Total row count pins the *combined* absence of drops/duplicates too
    // (e.g. a bug that recorded task_update under the chat_message count
    // would still be caught here even if the two filters above were
    // individually fooled).
    expect(events).toHaveLength(3);
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

  // #254 決定 1-b: `interrupted` は「ユーザーが止めた」ではなく「この応答は
  // 途中で終わっている」ことを表す列なので、LLM 失敗で途中打ち切りになった
  // 応答にも 1 を立てる。この向きが変わると、読み手は「途中で切れた応答」を
  // 完結した応答と見分けられなくなる。
  it("marks a partial reply persisted after an LLM failure as interrupted too — the column means \"ended early\", not \"the user stopped it\" (#254)", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementationOnce(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("途中までの応答");
        throw new Error("connection reset");
      },
    );
    const app = createApp(db, env);

    await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
    });

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(session.id) as Message[];
    expect(messages[1].interrupted).toBe(1);
  });

  it("persists a completed boss reply as not interrupted", async () => {
    const session = await createSession();
    streamBossMessageMock.mockImplementationOnce(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("最後まで書いた応答");
        return fakeTextMessage("最後まで書いた応答");
      },
    );
    const app = createApp(db, env);

    await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
    });

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(session.id) as Message[];
    expect(messages[1].interrupted).toBe(0);
  });

  it("passes the request's abort signal to streamBossMessage so the LLM call can actually be stopped (#254)", async () => {
    const session = await createSession();
    let observedSignal: AbortSignal | undefined;
    streamBossMessageMock.mockImplementationOnce(
      async (
        _client,
        _request,
        _callbacks: StreamBossMessageCallbacks,
        options?: { signal?: AbortSignal },
      ) => {
        observedSignal = options?.signal;
        return fakeTextMessage("応答");
      },
    );
    const app = createApp(db, env);

    await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
    });

    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  // 完了が勝つ（#254 論点5）: 生成が resolve し終えたあとに切断が観測されても、
  // その応答は完結しているので interrupted を立てない。
  it("persists a fully generated reply as not interrupted even when the client hangs up right after it completes (#254)", async () => {
    const session = await createSession();
    const caller = new AbortController();
    streamBossMessageMock.mockImplementationOnce(
      async (_client, _request, callbacks: StreamBossMessageCallbacks) => {
        callbacks.onTextDelta?.("全部書けた");
        // 応答が完成した直後に切断が起きる（レース）。
        caller.abort();
        return fakeTextMessage("全部書けた");
      },
    );
    const app = createApp(db, env);

    await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "相談です" }),
      signal: caller.signal,
    });

    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(session.id) as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user", "boss"]);
    expect(messages[1].interrupted).toBe(0);
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
