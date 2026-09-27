import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { DbPort } from "../db/db-port.js";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";
import type { DriverHook } from "../db/test-support/hooked-driver.js";

// #605・機能仕様 docs/features/async-db-layer.md 決定 2（T5・T6・S-END）:
// フック付きドライバで判定の読み出しの直後に別の流れを差し込み、割り込みを
// 決定的に作る。LLM・日報の生成・要約・会の開始のひとことはモックする。

const { createClaudeClientMock, streamBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
}));
vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return { ...actual, createClaudeClient: createClaudeClientMock, streamBossMessage: streamBossMessageMock };
});

const { generateDailyReportMock } = vi.hoisted(() => ({ generateDailyReportMock: vi.fn() }));
vi.mock("../reports/generate-daily-report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../reports/generate-daily-report.js")>();
  return { ...actual, generateDailyReport: generateDailyReportMock };
});

vi.mock("./session-summary.js", () => ({ generateSessionSummary: vi.fn().mockResolvedValue(null) }));

vi.mock("./meeting-opening.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./meeting-opening.js")>();
  return { ...actual, shouldGenerateMeetingOpening: () => false };
});

const { createSessionsRouter } = await import("./sessions-routes.js");

const SESSION_READ = "SELECT * FROM sessions WHERE id = ?";

interface Harness {
  db: DbPort;
  raw: Database.Database;
  hooks: DriverHook[];
  app: Hono;
}

const opened: Database.Database[] = [];

beforeEach(() => {
  createClaudeClientMock.mockReset().mockReturnValue({});
  streamBossMessageMock.mockReset().mockResolvedValue({ content: [{ type: "text", text: "了解した" }] });
  generateDailyReportMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  for (const raw of opened.splice(0)) {
    raw.close();
  }
});

async function setup(): Promise<Harness> {
  const { db, raw, hooks } = await createHookedTestDb();
  opened.push(raw);
  const app = new Hono();
  app.route("/api/sessions", createSessionsRouter(db, { LLM_BACKEND: "api" }, "api"));
  return { db, raw, hooks, app };
}

function injectOnce<T>(
  hooks: DriverHook[],
  matches: (sql: string) => boolean,
  inject: () => Promise<T> | T,
): () => Promise<T> {
  let started: Promise<T> | undefined;
  hooks.push({
    matches: (sql) => started === undefined && matches(sql),
    after: () => {
      started = Promise.resolve(inject());
    },
  });
  return () => {
    if (!started) {
      throw new Error("the injection point was never reached");
    }
    return started;
  };
}

function insertRawSession(raw: Database.Database, type: string, startedAt: Date): number {
  return Number(
    raw
      .prepare("INSERT INTO sessions (type, started_at) VALUES (?, ?)")
      .run(type, startedAt.toISOString()).lastInsertRowid,
  );
}

function insertRawMessage(raw: Database.Database, sessionId: number, role: string, content: string, at: Date): number {
  return Number(
    raw
      .prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, at.toISOString()).lastInsertRowid,
  );
}

function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function messageContents(raw: Database.Database, sessionId: number): string[] {
  return (
    raw
      .prepare("SELECT content FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as { content: string }[]
  ).map((row) => row.content);
}

describe("T5 createSession on the async DB port (#605)", () => {
  it("AC-10: two concurrent evening-session creations on the same local day create one session and reject the other with evening_session_already_exists", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 5, 18, 0, 0));
    const { raw, hooks, app } = await setup();
    const second = injectOnce(
      hooks,
      (sql) => sql.startsWith("SELECT * FROM sessions WHERE type = ?"),
      () => post(app, "/api/sessions", { type: "evening" }),
    );

    const first = await post(app, "/api/sessions", { type: "evening" });
    const secondRes = await second();

    const responses = [first, secondRes];
    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((res) => res.status === 409)!;
    expect(await rejected.json()).toMatchObject({ code: "evening_session_already_exists" });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE type = 'evening'").get()).toEqual({ n: 1 });
  });
});

describe("T6 chat message rewrite on the async DB port (#605)", () => {
  async function setupConversation(): Promise<Harness & { sessionId: number; lastUserMessageId: number }> {
    const harness = await setup();
    const sessionId = insertRawSession(harness.raw, "adhoc", new Date(2026, 6, 5, 9, 0, 0));
    insertRawMessage(harness.raw, sessionId, "user", "最初の相談", new Date(2026, 6, 5, 9, 1, 0));
    insertRawMessage(harness.raw, sessionId, "boss", "やれ", new Date(2026, 6, 5, 9, 2, 0));
    const lastUserMessageId = insertRawMessage(
      harness.raw,
      sessionId,
      "user",
      "書き直す前の発言",
      new Date(2026, 6, 5, 9, 3, 0),
    );
    return { ...harness, sessionId, lastUserMessageId };
  }

  function rewrite(app: Hono, sessionId: number, messageId: number) {
    return post(app, `/api/sessions/${sessionId}/messages`, {
      content: "書き直した発言",
      replaceFromMessageId: messageId,
    });
  }

  it("AC-11: when inserting the rewritten message fails, the truncation is not kept either", async () => {
    const { raw, hooks, app, sessionId, lastUserMessageId } = await setupConversation();
    let truncated = false;
    hooks.push(
      { matches: (sql) => sql.trimStart().startsWith("DELETE FROM messages"), after: () => void (truncated = true) },
      {
        matches: (sql) => truncated && sql.trimStart().startsWith("INSERT INTO messages"),
        after: () => {
          throw new Error("injected insert failure");
        },
      },
    );

    const res = await rewrite(app, sessionId, lastUserMessageId);

    expect(res.status).toBe(500);
    expect(truncated).toBe(true);
    expect(messageContents(raw, sessionId)).toEqual(["最初の相談", "やれ", "書き直す前の発言"]);
    expect(streamBossMessageMock).not.toHaveBeenCalled();
  });

  it("AC-20: a session end issued right after the rewrite checked the session is not ended does not run until the rewrite's write commits", async () => {
    const { raw, hooks, app, sessionId, lastUserMessageId } = await setupConversation();
    const order: string[] = [];
    let inTransaction = false;
    hooks.push(
      { matches: (sql) => sql === "BEGIN IMMEDIATE", after: () => void (inTransaction = true) },
      { matches: (sql) => sql.startsWith("UPDATE sessions SET ended_at"), after: () => void order.push("end") },
      { matches: (sql) => sql.trimStart().startsWith("INSERT INTO messages"), after: () => void order.push("rewrite") },
    );
    const end = injectOnce(
      hooks,
      (sql) => inTransaction && sql === SESSION_READ,
      () => post(app, `/api/sessions/${sessionId}/end`),
    );

    const res = await rewrite(app, sessionId, lastUserMessageId);
    await res.text();
    const endRes = await end();

    expect(res.status).toBe(200);
    expect(endRes.status).toBe(200);
    expect(order.slice(0, 2)).toEqual(["rewrite", "end"]);
    expect(messageContents(raw, sessionId)).toContain("書き直した発言");
  });

  it("AC-20 (end lands between the early check and the write): the rewrite is rejected with session_already_ended and nothing is written into the ended session", async () => {
    const { raw, hooks, app, sessionId, lastUserMessageId } = await setupConversation();
    let sessionReads = 0;
    const end = injectOnce(
      hooks,
      // 1 回目はルート冒頭の存在確認、2 回目が早期の終了済みの検査。
      (sql) => sql === SESSION_READ && ++sessionReads === 2,
      () => post(app, `/api/sessions/${sessionId}/end`),
    );

    const res = await rewrite(app, sessionId, lastUserMessageId);
    expect((await end()).status).toBe(200);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_already_ended" });
    expect(messageContents(raw, sessionId)).toEqual(["最初の相談", "やれ", "書き直す前の発言"]);
  });
});

describe("T6 rewrite target re-check inside the transaction (#605)", () => {
  it("a rewrite whose target is removed by another flow after the early check is rejected with message_not_found and writes nothing", async () => {
    const { db, raw, hooks, app } = await setup();
    const sessionId = insertRawSession(raw, "adhoc", new Date(2026, 6, 5, 9, 0, 0));
    insertRawMessage(raw, sessionId, "user", "u1", new Date(2026, 6, 5, 9, 1, 0));
    insertRawMessage(raw, sessionId, "boss", "b", new Date(2026, 6, 5, 9, 2, 0));
    const target = insertRawMessage(raw, sessionId, "user", "y", new Date(2026, 6, 5, 9, 3, 0));
    // 早期の検査が対象の発言の存在を確かめた直後に、別の流れ（例: 手前から
    // 切り捨てる別の書き直し）がその発言を消す。この削除は直列化層で早期の
    // 検査の直後・書き直しのトランザクションより前に確定する。
    const removal = injectOnce(
      hooks,
      (sql) => sql === "SELECT * FROM messages WHERE id = ? AND session_id = ?",
      () => db.run("DELETE FROM messages WHERE id = ?", [target]),
    );

    const res = await post(app, `/api/sessions/${sessionId}/messages`, {
      content: "y を書き直した",
      replaceFromMessageId: target,
    });
    await removal();

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "message_not_found" });
    expect(messageContents(raw, sessionId)).toEqual(["u1", "b"]);
  });
});

describe("S-END session end on the async DB port (#605)", () => {
  it("AC-23: two concurrent ends of the same session keep the ended_at of the one that committed first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 5, 10, 0, 0));
    const { raw, hooks, app } = await setup();
    const sessionId = insertRawSession(raw, "adhoc", new Date(2026, 6, 5, 9, 0, 0));
    let endedAtWrites = 0;
    hooks.push({
      matches: (sql) => sql.startsWith("UPDATE sessions SET ended_at"),
      after: () => void (endedAtWrites += 1),
    });
    const second = injectOnce(
      hooks,
      (sql) => sql === SESSION_READ,
      () => {
        // 後の要求は別の時刻で終了しようとする（上書きされれば値が変わる）。
        vi.setSystemTime(new Date(2026, 6, 5, 10, 5, 0));
        return post(app, `/api/sessions/${sessionId}/end`);
      },
    );

    const first = await post(app, `/api/sessions/${sessionId}/end`);
    const secondRes = await second();

    expect(first.status).toBe(200);
    expect(secondRes.status).toBe(200);
    const firstEndedAt = ((await first.json()) as { ended_at: string }).ended_at;
    expect(((await secondRes.json()) as { ended_at: string }).ended_at).toBe(firstEndedAt);
    expect(endedAtWrites).toBe(1);
    expect(raw.prepare("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId)).toEqual({
      ended_at: firstEndedAt,
    });
  });

  it("AC-24: two concurrent ends of the same evening session generate the daily report only once", async () => {
    const { raw, hooks, app } = await setup();
    const sessionId = insertRawSession(raw, "evening", new Date());
    const second = injectOnce(
      hooks,
      (sql) => sql === SESSION_READ,
      () => post(app, `/api/sessions/${sessionId}/end`),
    );

    const first = await post(app, `/api/sessions/${sessionId}/end`);
    const secondRes = await second();

    expect(first.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
  });
});
