import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertMessage } from "./messages-repository.js";
import type { Session } from "./session.js";
import type { Message } from "./message.js";

const { createClaudeClientMock, createBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  createBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    createBossMessage: createBossMessageMock,
  };
});

const { createApp } = await import("../app.js");

function fakeTextMessage(text: string): Anthropic.Message {
  return {
    content: text ? [{ type: "text", text, citations: null }] : [],
  } as unknown as Anthropic.Message;
}

interface ErrorBody {
  error: string;
}

interface ErrorBodyWithCode extends ErrorBody {
  code: string;
}

async function postSession(app: ReturnType<typeof createApp>, type: string) {
  return app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("sessions routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    createBossMessageMock.mockReset();
    createClaudeClientMock.mockReturnValue({});
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /api/sessions", () => {
    it.each(["morning", "evening", "adhoc"] as const)(
      "creates a session with type %s",
      async (type) => {
        const app = createApp(db);

        const res = await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type }),
        });

        expect(res.status).toBe(201);
        const body = await readJson<Session>(res);
        expect(body).toMatchObject({ type, ended_at: null, summary: null });
        expect(typeof body.id).toBe("number");
        expect(typeof body.started_at).toBe("string");
      },
    );

    it("returns 400 when type is missing", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when type is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "lunch" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when the request body is not valid JSON", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    describe("evening session daily limit", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("returns 409 with code evening_session_already_exists when an evening session already exists today, without inserting a new row", async () => {
        const app = createApp(db);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
        const first = await postSession(app, "evening");
        expect(first.status).toBe(201);

        vi.setSystemTime(new Date(2026, 7, 14, 20, 0));
        const second = await postSession(app, "evening");

        expect(second.status).toBe(409);
        const body = await readJson<ErrorBodyWithCode>(second);
        expect(body.code).toBe("evening_session_already_exists");
        expect(typeof body.error).toBe("string");

        const list = await readJson<Session[]>(
          await app.request("/api/sessions?type=evening"),
        );
        expect(list).toHaveLength(1);
      });

      it("allows today's evening session when only a previous day's evening session exists (date boundary)", async () => {
        const app = createApp(db);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 13, 23, 50));
        const previousDay = await readJson<Session>(
          await postSession(app, "evening"),
        );

        vi.setSystemTime(new Date(2026, 7, 14, 0, 30));
        await app.request(`/api/sessions/${previousDay.id}/end`, {
          method: "POST",
        });

        vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
        const today = await postSession(app, "evening");

        expect(today.status).toBe(201);
        const list = await readJson<Session[]>(
          await app.request("/api/sessions?type=evening"),
        );
        expect(list).toHaveLength(2);
      });

      it("returns 409 when today's evening session is already ended", async () => {
        const app = createApp(db);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
        const first = await readJson<Session>(await postSession(app, "evening"));
        await app.request(`/api/sessions/${first.id}/end`, { method: "POST" });

        vi.setSystemTime(new Date(2026, 7, 14, 20, 0));
        const second = await postSession(app, "evening");

        expect(second.status).toBe(409);
        const body = await readJson<ErrorBodyWithCode>(second);
        expect(body.code).toBe("evening_session_already_exists");
      });

      it("does not limit morning or adhoc sessions created on the same day", async () => {
        const app = createApp(db);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 14, 9, 0));

        const firstMorning = await postSession(app, "morning");
        const secondMorning = await postSession(app, "morning");
        const firstAdhoc = await postSession(app, "adhoc");
        const secondAdhoc = await postSession(app, "adhoc");

        expect(firstMorning.status).toBe(201);
        expect(secondMorning.status).toBe(201);
        expect(firstAdhoc.status).toBe(201);
        expect(secondAdhoc.status).toBe(201);
      });
    });
  });

  describe("POST /api/sessions — meeting opening (Issue #271, docs/features/meeting-start-announcement.md 判断1〜4)", () => {
    it("AC-1: creates an evening session and persists a generated boss opening message", async () => {
      const app = createApp(db);
      createBossMessageMock.mockResolvedValue(fakeTextMessage("今日の進捗を聞かせろ。"));

      const res = await postSession(app, "evening");
      const session = await readJson<Session>(res);

      expect(res.status).toBe(201);
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "boss",
        content: "今日の進捗を聞かせろ。",
      });
    });

    it("AC-2: creates a morning session and persists a generated boss opening message", async () => {
      const app = createApp(db);
      createBossMessageMock.mockResolvedValue(fakeTextMessage("今日はA案件から片付けろ。"));

      const res = await postSession(app, "morning");
      const session = await readJson<Session>(res);

      expect(res.status).toBe(201);
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "boss",
        content: "今日はA案件から片付けろ。",
      });
    });

    it("AC-3: does not generate an opening message for an adhoc session", async () => {
      const app = createApp(db);

      const res = await postSession(app, "adhoc");
      const session = await readJson<Session>(res);

      expect(res.status).toBe(201);
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(0);
      expect(createClaudeClientMock).not.toHaveBeenCalled();
    });

    it("AC-4/AC-5: still returns 201 and persists the fixed fallback text when generation fails", async () => {
      const app = createApp(db);
      createBossMessageMock.mockRejectedValue(new Error("connection reset with request id xyz"));

      const res = await postSession(app, "evening");
      const session = await readJson<Session>(res);

      expect(res.status).toBe(201);
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("boss");
      expect(messages[0].content.length).toBeGreaterThan(0);
    });

    it("AC-7: does not record a chat_message activity event when generating the opening message", async () => {
      const app = createApp(db);
      createBossMessageMock.mockResolvedValue(fakeTextMessage("今日の進捗を聞かせろ。"));

      await postSession(app, "evening");

      const events = db.prepare("SELECT * FROM activity_events").all() as Array<{
        type: string;
      }>;
      expect(events.map((e) => e.type)).not.toContain("chat_message");
    });

    // AC-6 の純粋関数側（type × messageCount の真理値表）は
    // meeting-opening.test.ts の shouldGenerateMeetingOpening が担保する。
    // ここで固定するのは、ユーザーに見える「同じ日の同じ会を再開しても
    // 開始ひとことが重複しない」というルート層の振る舞いのほう。
    it("AC-6: re-creating today's evening session is rejected and does not add a second opening message", async () => {
      const app = createApp(db);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
      createBossMessageMock.mockResolvedValue(fakeTextMessage("今日の進捗を聞かせろ。"));

      const session = await readJson<Session>(await postSession(app, "evening"));
      const second = await postSession(app, "evening");

      expect(second.status).toBe(409);
      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ?")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(1);
      expect(createBossMessageMock).toHaveBeenCalledTimes(1);
    });

    it("AC-6: a session that already has messages does not get a second opening message", async () => {
      const app = createApp(db);
      createBossMessageMock.mockResolvedValue(fakeTextMessage("今日はA案件から片付けろ。"));

      const session = await readJson<Session>(await postSession(app, "morning"));
      insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "了解、A案件からやる",
      });
      createBossMessageMock.mockClear();

      // 同じ行に対してトリガが再度走っても（クライアントの loadTodaysSession
      // による再利用に依存せず）生成しないことを、サーバ側のガードで固定する。
      await postSession(app, "morning");

      const messages = db
        .prepare("SELECT * FROM messages WHERE session_id = ? AND role = 'boss'")
        .all(session.id) as Message[];
      expect(messages).toHaveLength(1);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns an empty array when no sessions exist", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions");

      expect(res.status).toBe(200);
      expect(await readJson<Session[]>(res)).toEqual([]);
    });

    it("returns sessions ordered by started_at descending (most recent first)", async () => {
      const app = createApp(db);

      const first = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      const second = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request("/api/sessions");

      expect(res.status).toBe(200);
      const body = await readJson<Session[]>(res);
      expect(body.map((s) => s.id)).toEqual([second.id, first.id]);
    });

    it("filters sessions by ?type=", async () => {
      const app = createApp(db);

      await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "morning" }),
      });
      const adhoc = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request("/api/sessions?type=adhoc");

      expect(res.status).toBe(200);
      const body = await readJson<Session[]>(res);
      expect(body.map((s) => s.id)).toEqual([adhoc.id]);
    });

    it("returns 400 when ?type= is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions?type=lunch");

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });
  });

  describe("GET /api/sessions/:id/messages", () => {
    it("returns an empty array when the session has no messages", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );

      const res = await app.request(`/api/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      expect(await readJson<Message[]>(res)).toEqual([]);
    });

    it("returns messages ordered by created_at ascending", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );
      const first = insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "最初の発言",
      });
      const second = insertMessage(db, {
        session_id: session.id,
        role: "boss",
        content: "ボスの応答",
      });

      const res = await app.request(`/api/sessions/${session.id}/messages`);

      expect(res.status).toBe(200);
      const body = await readJson<Message[]>(res);
      expect(body.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it("returns 404 for a non-existent session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/9999/messages");

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 404 for a non-numeric session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/not-a-number/messages");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/end", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("records ended_at (ISO 8601) on the session and returns it", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T09:30:00+09:00"));

      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body).toMatchObject({
        id: session.id,
        ended_at: new Date("2026-07-06T09:30:00+09:00").toISOString(),
      });
    });

    it("returns 404 for a non-existent session id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/sessions/9999/end", {
        method: "POST",
      });

      expect(res.status).toBe(404);
      const body = await readJson<{ error: string }>(res);
      expect(typeof body.error).toBe("string");
    });

    it("is idempotent: ending an already-ended session returns 200 with the original ended_at", async () => {
      const app = createApp(db);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T18:00:00+09:00"));
      const first = await readJson<Session>(
        await app.request(`/api/sessions/${session.id}/end`, { method: "POST" }),
      );

      vi.setSystemTime(new Date("2026-07-06T19:00:00+09:00"));
      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body).toEqual(first);
    });

    it("AC-1: ending a morning session generates and persists a summary from its messages", async () => {
      const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
      const app = createApp(db, env);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      insertMessage(db, {
        session_id: session.id,
        role: "user",
        content: "資料作成を今日中に終わらせます",
      });
      insertMessage(db, {
        session_id: session.id,
        role: "boss",
        content: "資料作成を最優先にしろ",
      });
      createBossMessageMock.mockResolvedValue(
        fakeTextMessage("資料作成を最優先にすることを決定した。"),
      );

      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body.summary).toBe("資料作成を最優先にすることを決定した。");

      const stored = db
        .prepare("SELECT summary FROM sessions WHERE id = ?")
        .get(session.id) as { summary: string | null };
      expect(stored.summary).toBe("資料作成を最優先にすることを決定した。");
    });

    it("AC-3: still returns 200 with ended_at set (and summary left null) when summary generation fails", async () => {
      const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
      const app = createApp(db, env);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      insertMessage(db, { session_id: session.id, role: "user", content: "進捗報告です" });
      createBossMessageMock.mockRejectedValue(new Error("connection reset with request id xyz"));

      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body.summary).toBeNull();
      expect(typeof body.ended_at).toBe("string");
    });

    it("decision 3: does not attempt summary generation for adhoc sessions", async () => {
      const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
      const app = createApp(db, env);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "adhoc" }),
        }),
      );
      insertMessage(db, { session_id: session.id, role: "user", content: "ちょっと相談です" });

      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body.summary).toBeNull();
      expect(createClaudeClientMock).not.toHaveBeenCalled();
      expect(createBossMessageMock).not.toHaveBeenCalled();
    });

    it("does not regenerate or overwrite the summary when re-ending an already-summarized session", async () => {
      const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
      const app = createApp(db, env);
      const session = await readJson<Session>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "morning" }),
        }),
      );
      insertMessage(db, { session_id: session.id, role: "user", content: "報告します" });
      // Issue #271: session creation above already invoked createBossMessage
      // once for the (unconfigured, fallback-triggering) meeting-opening
      // generation. Clear the call count here so this test's assertion below
      // only reflects the summary-generation call count it's actually named
      // for — unrelated to whether the opening line was generated.
      createBossMessageMock.mockClear();
      createBossMessageMock.mockResolvedValue(fakeTextMessage("最初の要約"));

      const first = await readJson<Session>(
        await app.request(`/api/sessions/${session.id}/end`, { method: "POST" }),
      );
      expect(first.summary).toBe("最初の要約");

      createBossMessageMock.mockResolvedValue(fakeTextMessage("2回目の要約（上書きされてはならない）"));
      const res = await app.request(`/api/sessions/${session.id}/end`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await readJson<Session>(res);
      expect(body.summary).toBe("最初の要約");
      expect(createBossMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
