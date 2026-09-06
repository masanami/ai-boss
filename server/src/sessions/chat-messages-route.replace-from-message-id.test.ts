import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { endSession } from "./sessions-repository.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

/**
 * Issue #376: `replaceFromMessageId` の受け口とやりなおし経路のガード。
 *
 * `chat-messages-route.test.ts` とは別ファイルにしてある — AC-21（挿入失敗時
 * に切り捨てもロールバックされること）の検証だけ `./messages-repository.js`
 * を部分モックする必要があり、その `vi.mock` をこのファイルに閉じ込めるため
 * （vitest はテストファイルごとにモジュールグラフを分離するので、既存の
 * `chat-messages-route.test.ts` 側のテストには影響しない）。
 */

const {
  createClaudeClientMock,
  streamBossMessageMock,
  createBossMessageMock,
  requestVerdictMock,
} = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
  createBossMessageMock: vi.fn(),
  // AC-24b's `POST /:id/end` reaches extract-evening-summary.ts's
  // requestVerdict call. Left unmocked, the fake `{}` client handle from
  // createClaudeClientMock would reach the real dispatch and fail slowly
  // with real retries (same rationale as
  // sessions-routes-daily-report-hook.test.ts's requestVerdictMock).
  requestVerdictMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
    createBossMessage: createBossMessageMock,
    requestVerdict: requestVerdictMock,
  };
});

// AC-21 専用: `insertMessage` だけを一時的に差し替え可能にする。既定では実装
// をそのまま呼ぶ（他のテストへは影響しない）。`realInsertMessageRef` に実体を
// 保持しておき、beforeEach で `mockReset()` + 実体への `mockImplementation`
// し直せるようにする — `mockClear()` だけでは `mockImplementationOnce` の
// キュー（AC-21 が積む例外投げ実装）が残ってしまい、そのテストの中で消費
// されなかった場合に後続テストへ漏れる（self-review 指摘）。
type InsertMessageFn = typeof import("./messages-repository.js").insertMessage;
const { insertMessageMock, realInsertMessageRef } = vi.hoisted(() => ({
  insertMessageMock: vi.fn(),
  realInsertMessageRef: {} as { current: InsertMessageFn },
}));

vi.mock("./messages-repository.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messages-repository.js")>();
  realInsertMessageRef.current = actual.insertMessage;
  insertMessageMock.mockImplementation(actual.insertMessage);
  return { ...actual, insertMessage: insertMessageMock };
});

const { createApp } = await import("../app.js");

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

function fakeTextMessage(text: string): FakeBossLlmMessage {
  return {
    content: text ? [{ type: "text", text }] : [],
  };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function messagesOf(db: Database.Database, sessionId: number): Message[] {
  return db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC")
    .all(sessionId) as Message[];
}

function activityEventsOf(
  db: Database.Database,
): Array<{ type: string; task_id: number | null }> {
  return db.prepare("SELECT * FROM activity_events").all() as Array<{
    type: string;
    task_id: number | null;
  }>;
}

describe("POST /api/sessions/:id/messages with replaceFromMessageId (Issue #376)", () => {
  let db: Database.Database;
  const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    createBossMessageMock.mockReset();
    requestVerdictMock.mockReset();
    // `mockReset()` (not `mockClear()`) so a once-implementation queued by
    // AC-21 but never consumed can't leak into a later test; then restore
    // the real implementation as the default (see the comment above this
    // mock's declaration).
    insertMessageMock.mockReset();
    insertMessageMock.mockImplementation(realInsertMessageRef.current);
    createClaudeClientMock.mockReturnValue({});
    createBossMessageMock.mockResolvedValue({ content: [] });
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    requestVerdictMock.mockResolvedValue({
      called: true,
      result: {
        valid: true,
        data: { reportSummary: "要点", bossComment: "講評", keyDecisions: "なし", carryOver: "なし" },
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  async function createSession(
    type: "adhoc" | "morning" | "evening" = "adhoc",
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

  async function sendMessage(
    sessionId: number,
    content: string,
    replaceFromMessageId?: number,
  ): Promise<Response> {
    const app = createApp(db, env);
    return app.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        ...(replaceFromMessageId !== undefined ? { replaceFromMessageId } : {}),
      }),
    });
  }

  // --- AC-9: replaceFromMessageId が正の整数でない ---
  it("AC-9: returns 400 and deletes/inserts nothing when replaceFromMessageId is not a positive integer", async () => {
    const session = await createSession();
    const before = messagesOf(db, session.id);

    const res = await sendMessage(session.id, "書き直した内容", -1);

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body.error).toBe("replaceFromMessageId must be a positive integer");
    expect(messagesOf(db, session.id)).toEqual(before);
  });

  // AC-14 (経路1/5): AC-9 の拒否経路で LLM 呼び出しが起きない
  it("AC-14 (via AC-9): does not call streamBossMessage when replaceFromMessageId is invalid", async () => {
    const session = await createSession();

    await sendMessage(session.id, "書き直した内容", -1);

    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  // --- AC-10: セッションが終了済み ---
  it("AC-10: returns 409 with code session_already_ended and deletes/inserts nothing for an ended session", async () => {
    const session = await createSession("evening");
    const firstRes = await sendMessage(session.id, "最初の発言");
    await firstRes.text();
    const target = messagesOf(db, session.id).find((m) => m.role === "user")!;
    endSession(db, session.id);
    const before = messagesOf(db, session.id);

    const res = await sendMessage(session.id, "書き直した内容", target.id);

    expect(res.status).toBe(409);
    const body = await readJson<ErrorBody>(res);
    expect(body).toEqual({
      error: "終了したセッションの発言は編集できません",
      code: "session_already_ended",
    });
    expect(messagesOf(db, session.id)).toEqual(before);
  });

  // AC-14 (経路2/5)
  it("AC-14 (via AC-10): does not call streamBossMessage for an ended session", async () => {
    const session = await createSession("evening");
    const firstRes = await sendMessage(session.id, "最初の発言");
    await firstRes.text();
    const target = messagesOf(db, session.id).find((m) => m.role === "user")!;
    endSession(db, session.id);
    streamBossMessageMock.mockClear();

    await sendMessage(session.id, "書き直した内容", target.id);

    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  // Negative control for AC-10 (self-review 指摘: このガードがやりなおし
  // 経路にだけ足されていること — 通常送信に 409 が漏れ出していないこと —
  // を直接確認するテストがそれまで無かった). 通常送信（replaceFromMessageId
  // 未指定）は終了済みセッションでも従来どおり 200/SSE のまま。
  it("does not 409 an ended session for a normal send without replaceFromMessageId (guard is scoped to the rewrite path only)", async () => {
    const session = await createSession("evening");
    const firstRes = await sendMessage(session.id, "最初の発言");
    await firstRes.text();
    endSession(db, session.id);

    const res = await sendMessage(session.id, "通常の追加発言");

    expect(res.status).toBe(200);
    const events = parseSseEvents(await res.text());
    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  // --- AC-11: 別セッションのメッセージ id ---
  it("AC-11: returns 404 with code message_not_found and deletes/inserts nothing for a cross-session id", async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    const resB = await sendMessage(sessionB.id, "Bでの発言");
    await resB.text();
    const messageInB = messagesOf(db, sessionB.id)[0];
    const beforeA = messagesOf(db, sessionA.id);
    const beforeB = messagesOf(db, sessionB.id);

    const res = await sendMessage(sessionA.id, "書き直した内容", messageInB.id);

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(body).toEqual({
      error: `message ${messageInB.id} not found in session ${sessionA.id}`,
      code: "message_not_found",
    });
    expect(messagesOf(db, sessionA.id)).toEqual(beforeA);
    expect(messagesOf(db, sessionB.id)).toEqual(beforeB);
  });

  // AC-14 (経路3/5)
  it("AC-14 (via AC-11): does not call streamBossMessage for a cross-session id", async () => {
    const sessionA = await createSession();
    const sessionB = await createSession();
    const resB = await sendMessage(sessionB.id, "Bでの発言");
    await resB.text();
    const messageInB = messagesOf(db, sessionB.id)[0];
    streamBossMessageMock.mockClear();

    await sendMessage(sessionA.id, "書き直した内容", messageInB.id);

    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  // --- AC-12: 存在しないメッセージ id ---
  it("AC-12: returns 404 with code message_not_found for a non-existent message id", async () => {
    const session = await createSession();

    const res = await sendMessage(session.id, "書き直した内容", 999_999);

    expect(res.status).toBe(404);
    const body = await readJson<ErrorBody>(res);
    expect(body).toEqual({
      error: `message 999999 not found in session ${session.id}`,
      code: "message_not_found",
    });
  });

  // AC-14 (経路4/5)
  it("AC-14 (via AC-12): does not call streamBossMessage for a non-existent message id", async () => {
    const session = await createSession();

    await sendMessage(session.id, "書き直した内容", 999_999);

    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  // --- AC-13: 対象メッセージが role: "boss" ---
  it("AC-13: returns 400 with code message_not_editable and deletes/inserts nothing for a boss message", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const bossMessage = messagesOf(db, session.id).find((m) => m.role === "boss")!;
    const before = messagesOf(db, session.id);

    const res = await sendMessage(session.id, "書き直した内容", bossMessage.id);

    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body).toEqual({
      error: "ボスの発言は編集できません",
      code: "message_not_editable",
    });
    expect(messagesOf(db, session.id)).toEqual(before);
  });

  // AC-14 (経路5/5)
  it("AC-14 (via AC-13): does not call streamBossMessage for a boss message target", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const bossMessage = messagesOf(db, session.id).find((m) => m.role === "boss")!;
    streamBossMessageMock.mockClear();

    await sendMessage(session.id, "書き直した内容", bossMessage.id);

    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  // --- 正常系 ---
  it("AC-15/16/17: truncates from the target, inserts the rewritten content, and sends only the surviving+rewritten content to the LLM", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;
    const res2 = await sendMessage(session.id, "2つ目の発言");
    await res2.text();
    streamBossMessageMock.mockClear();
    streamBossMessageMock.mockImplementationOnce(
      async (
        _client: unknown,
        _request: unknown,
        callbacks: { onTextDelta?: (delta: string) => void },
      ) => {
        callbacks.onTextDelta?.("やりなおし後の応答");
        return fakeTextMessage("やりなおし後の応答");
      },
    );

    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    await res.text();

    // AC-15: 最終的な永続化は「対象より前 + 書き直した user + 新しいboss応答」だけ
    const finalMessages = messagesOf(db, session.id);
    expect(finalMessages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "書き直した内容" },
      { role: "boss", content: "やりなおし後の応答" },
    ]);

    // AC-16/17: LLM へ渡された列に旧発言は含まれず、末尾は書き直した user
    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [{ role: "user", content: "書き直した内容" }],
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("AC-18: records exactly one additional chat_message activity event and keeps the earlier one", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;
    const chatMessageEventsBefore = activityEventsOf(db).filter(
      (e) => e.type === "chat_message",
    );
    expect(chatMessageEventsBefore).toHaveLength(1);

    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    await res.text();

    const chatMessageEventsAfter = activityEventsOf(db).filter(
      (e) => e.type === "chat_message",
    );
    expect(chatMessageEventsAfter).toHaveLength(2);
  });

  // AC-19/20 の証拠力を実際に持たせるため、副作用として何かが *実際に
  // 記録される* ツール（update_task — tasks-repository.ts の
  // recordActivityEvent(db, { type: "task_update", task_id })）を使う。
  // create_task は activity_events に一切書かないため、以前のバージョンの
  // このテストは「0 件のまま」という恒真アサーションしか立てられず、将来
  // 切り捨てが activity_events まで巻き込む回帰があっても検出できなかった
  // （self-review 指摘）。
  it("AC-19/20: keeps a tool's side effect (an updated task) and its task_update activity_events row after the containing turn is truncated away", async () => {
    const session = await createSession();
    const app = createApp(db, env);
    const task = await readJson<{ id: number; priority: string }>(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "資料作成" }),
      }),
    );
    expect(task.priority).not.toBe("high");

    streamBossMessageMock.mockImplementationOnce(
      async (
        _client: unknown,
        _request: unknown,
        callbacks: {
          executeTool?: (
            name: string,
            input: unknown,
          ) => Promise<{ content: string; isError: boolean }> | { content: string; isError: boolean };
          onToolEvent?: (event: {
            name: string;
            input: unknown;
            result: string;
            isError: boolean;
          }) => void | Promise<void>;
          onTextDelta?: (delta: string) => void;
        },
      ) => {
        const result = await callbacks.executeTool!("update_task", {
          id: task.id,
          priority: "high",
        });
        await callbacks.onToolEvent?.({
          name: "update_task",
          input: { id: task.id, priority: "high" },
          result: result.content,
          isError: result.isError,
        });
        callbacks.onTextDelta?.("優先度を上げた");
        return fakeTextMessage("優先度を上げた");
      },
    );
    const res1 = await sendMessage(session.id, "優先度を上げて");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;

    // Before truncation: the tool's side effect is really there (not a
    // tautology — this would fail if update_task's own persistence broke).
    const taskUpdateEventsBefore = activityEventsOf(db).filter(
      (e) => e.type === "task_update" && e.task_id === task.id,
    );
    expect(taskUpdateEventsBefore).toHaveLength(1);

    streamBossMessageMock.mockResolvedValue(fakeTextMessage("わかった"));
    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    await res.text();

    // AC-19: the task updated by the truncated turn's tool call keeps the
    // change — it is not deleted or rolled back. (No GET /api/tasks/:id
    // route exists, so this reads the row directly.)
    const updatedTask = db
      .prepare("SELECT priority FROM tasks WHERE id = ?")
      .get(task.id) as { priority: string } | undefined;
    expect(updatedTask?.priority).toBe("high");

    // AC-20: the task_update activity_events row from the truncated turn
    // still exists (exactly once — neither deleted nor duplicated).
    const taskUpdateEventsAfter = activityEventsOf(db).filter(
      (e) => e.type === "task_update" && e.task_id === task.id,
    );
    expect(taskUpdateEventsAfter).toHaveLength(1);
  });

  it("AC-21: does not truncate when the rewritten-message insert fails (delete+insert share one transaction)", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;
    const before = messagesOf(db, session.id);

    insertMessageMock.mockImplementationOnce(() => {
      throw new Error("simulated insert failure");
    });

    // The route wraps the delete+insert transaction in its own try/catch
    // (same {error} JSON shape as its other uncoded 500 branch), rather than
    // letting the error fall through to Hono's default text/plain handler.
    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    expect(res.status).toBe(500);
    const body = await readJson<ErrorBody>(res);
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toContain("simulated insert failure");

    // The delete inside the same db.transaction() must have rolled back too.
    expect(messagesOf(db, session.id)).toEqual(before);
  });

  it("AC-22: still streams a text/done SSE sequence for a successful rewrite", async () => {
    const session = await createSession();
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;
    streamBossMessageMock.mockImplementationOnce(
      async (
        _client: unknown,
        _request: unknown,
        callbacks: { onTextDelta?: (delta: string) => void },
      ) => {
        callbacks.onTextDelta?.("やり直した");
        return fakeTextMessage("やり直した");
      },
    );

    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    const events = parseSseEvents(await res.text());

    expect(events.find((e) => e.event === "text")).toBeDefined();
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(JSON.parse(doneEvent!.data)).toMatchObject({ content: "やり直した" });
  });

  it("AC-23: keeps the meeting-opening boss line and still sends role user first to the LLM after rewriting the first user message", async () => {
    const session = await createSession("evening");
    // Meeting-opening line persisted first (role: boss), then the user's
    // first message.
    const openingLine = messagesOf(db, session.id)[0];
    expect(openingLine.role).toBe("boss");

    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;
    streamBossMessageMock.mockClear();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));

    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    await res.text();

    // The opening line survives (not part of this session's *user* thread
    // being truncated away — it's earlier than the target).
    expect(messagesOf(db, session.id)[0]).toMatchObject({ role: "boss" });
    expect(streamBossMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    const callArgs = streamBossMessageMock.mock.calls[0][1] as { messages: Array<{ role: string }> };
    expect(callArgs.messages[0].role).toBe("user");
  });

  it("AC-24/AC-24b: keeps at least one user message after rewriting the only message in an evening session, and the daily report still generates on end", async () => {
    const session = await createSession("evening");
    const res1 = await sendMessage(session.id, "最初の発言");
    await res1.text();
    const firstUser = messagesOf(db, session.id).find((m) => m.role === "user")!;

    streamBossMessageMock.mockClear();
    streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した"));
    const res = await sendMessage(session.id, "書き直した内容", firstUser.id);
    await res.text();

    const userMessageCount = messagesOf(db, session.id).filter(
      (m) => m.role === "user",
    ).length;
    expect(userMessageCount).toBeGreaterThanOrEqual(1);

    const app = createApp(db, env);
    const endRes = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });
    expect(endRes.status).toBe(200);

    const reportRow = db.prepare("SELECT COUNT(*) as count FROM daily_reports").get() as {
      count: number;
    };
    expect(reportRow.count).toBe(1);
  });

  // --- #255 × #270 の相互作用: 切り捨ては「当日の随時チャット」参考情報にも及ぶ ---
  //
  // Issue #270（PR #373）が、会中のボスへ渡す system プロンプトに「当日の随時
  // チャット」の参考情報ブロックを足した（`collectTodaysAdhocContext` →
  // `listTodaysAdhocMessages`）。これは `listMessagesBySessionId` とは**別の
  // 読み出し経路**なので、#255 の完了条件「書き直した後、元の発言はボスの文脈に
  // 含まれない」がこちらでも成り立つことを固定しておく必要がある。
  //
  // 現状は物理 DELETE（`deleteMessagesFrom`）＋「切り捨てを両方の文脈読み出しより
  // 前に置く」順序で構造的に担保されているが、その担保はどちらも暗黙のもの
  // （論理削除へ変える／参考情報をキャッシュする／切り捨てを後段へ動かす、の
  // いずれでも静かに壊れる）。ここで固定しておかないと、二重に読まれる面が
  // 増えたことに気づかないまま回帰しうる。
  describe("#270 の当日の随時チャット参考情報との相互作用", () => {
    function lastSystemPrompt(): string {
      const calls = streamBossMessageMock.mock.calls;
      return (calls[calls.length - 1][1] as { system: string }).system;
    }

    it("随時チャットで切り捨てた発言は、その後の朝会でボスへ渡る当日の随時チャット参考情報に残らない", async () => {
      const adhoc = await createSession("adhoc");

      // 随時チャットで 2 ターン会話する。1 ターン目の発言を後で書き直す。
      streamBossMessageMock.mockResolvedValue(
        fakeTextMessage("それは経費で落とせ。"),
      );
      await (await sendMessage(adhoc.id, "誤った内容を送ってしまった")).text();
      const firstUser = messagesOf(db, adhoc.id).find((m) => m.role === "user")!;
      await (await sendMessage(adhoc.id, "ついでにこれも相談したい")).text();

      // 1 ターン目の発言を書き直す = それ以降の随時チャットを切り捨てる。
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("了解した。"));
      await (
        await sendMessage(adhoc.id, "本当に相談したかった内容", firstUser.id)
      ).text();

      // 朝会を開始して発言する。ここで #373 の参考情報ブロックが組み立てられる。
      const morning = await createSession("morning");
      streamBossMessageMock.mockClear();
      streamBossMessageMock.mockResolvedValue(fakeTextMessage("報告を受けた。"));
      await (await sendMessage(morning.id, "今日の予定を報告します")).text();

      const system = lastSystemPrompt();
      // 書き直した内容は参考情報に載る（機能そのものは生きている）。
      expect(system).toContain("本当に相談したかった内容");
      // 切り捨てた発言（ユーザー・ボスの両方）は載らない。
      expect(system).not.toContain("誤った内容を送ってしまった");
      expect(system).not.toContain("ついでにこれも相談したい");
      expect(system).not.toContain("それは経費で落とせ。");
    });
  });
});
