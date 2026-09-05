import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import type { DailyReport, DailyReportSummary } from "./daily-report.js";
import type { SessionType } from "../sessions/session.js";

interface ErrorBodyWithCode {
  error: string;
  code: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ローカル日付基準・TZ非依存: new Date(y, m, d, h, mi) から toISOString() で
// DB 用の値を作る（CLAUDE.md「テスト方針」）。
function iso(y: number, m: number, d: number, h: number, mi: number, s = 0): string {
  return new Date(y, m - 1, d, h, mi, s).toISOString();
}

function insertRawSession(
  db: Database.Database,
  type: SessionType,
  startedAt: string,
  endedAt: string | null,
): number {
  const result = db
    .prepare("INSERT INTO sessions (type, started_at, ended_at) VALUES (?, ?, ?)")
    .run(type, startedAt, endedAt);
  return Number(result.lastInsertRowid);
}

function insertRawMessage(
  db: Database.Database,
  sessionId: number,
  role: "user" | "boss",
  content: string,
  createdAt: string,
): void {
  db.prepare(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, role, content, createdAt);
}

function insertRawDailyReport(
  db: Database.Database,
  date: string,
  content: string,
  eveningSessionId: number,
  createdAt: string,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO daily_reports (date, content, evening_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(date, content, eveningSessionId, createdAt, updatedAt);
}

const { createClaudeClientMock, requestVerdictMock, createBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  requestVerdictMock: vi.fn(),
  // Issue #271: `POST /api/sessions` with `type: "evening"` now also
  // triggers the meeting-opening generator (`createBossMessage`), which this
  // file never intended to exercise (only `requestVerdict` is mocked below).
  // Left unmocked, this hits the exact same real-dispatch/real-retry hazard
  // documented on `generateSessionSummaryMock` below — and worse under this
  // file's `vi.useFakeTimers()` (no automatic advancement) tests: the retry
  // loop's backoff `delay()` never resolves, hanging the test outright
  // rather than merely slowing it down.
  createBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    requestVerdict: requestVerdictMock,
    createBossMessage: createBossMessageMock,
  };
});

// Issue #214: `POST /:id/end` also drives session-summary generation
// (Issue #96, sessions-routes.ts step 1) via `generateSessionSummary`, which
// calls the *real* `createBossMessage` — a call this file never intended to
// exercise (only `requestVerdict`, used by the report's value-extraction
// step, is mocked above; `createClaudeClientMock` returns `{ client: {} }`,
// which has no `.messages`). Before #214 this was harmless: the api
// backend's `dispatchCreate` called `createApiMessage` directly, so the
// missing `.messages` threw synchronously and was swallowed by
// `generateSessionSummary`'s own try/catch with no timer involved. #214
// wrapped `dispatchCreate`'s `api` branch in `runWithTimeoutAndRetry`, so
// the same synchronous throw is now caught *inside* the retry loop and
// followed by a real backoff `delay()` wait before retrying — under this
// suite's `vi.useFakeTimers()` that delay's `setTimeout` never fires,
// hanging the 3 tests that call `POST /:id/end` below. Mocking
// `session-summary.js` (same pattern as
// `sessions-routes-daily-report-hook.test.ts`) keeps this file's scope to
// only what it actually tests (report content), sidestepping the
// unintended real dispatch entirely — session summary text plays no part
// in daily-report content (sessions-routes.ts's comment: the two steps are
// independent).
const { generateSessionSummaryMock } = vi.hoisted(() => ({
  generateSessionSummaryMock: vi.fn(),
}));

vi.mock("../sessions/session-summary.js", () => ({
  generateSessionSummary: generateSessionSummaryMock,
}));

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

describe("reports routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createBossMessageMock.mockReset();
    generateSessionSummaryMock.mockReset();
    createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
    // Empty content -> meeting-opening's own "text === ''" branch -> its
    // fixed fallback text is persisted, without touching the retry path.
    createBossMessageMock.mockResolvedValue({ content: [] });
    requestVerdictMock.mockResolvedValue({
      called: true,
      result: {
        valid: true,
        data: { reportSummary: "要点", bossComment: "講評", keyDecisions: "なし", carryOver: "なし" },
      },
    });
    generateSessionSummaryMock.mockResolvedValue("夕会の要約");
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  describe("GET /api/reports", () => {
    it("returns an empty array when no reports exist", async () => {
      const app = createApp(db, env);

      const res = await app.request("/api/reports");

      expect(res.status).toBe(200);
      expect(await readJson<DailyReportSummary[]>(res)).toEqual([]);
    });

    it("returns reports newest-first, with only date/created_at/updated_at (no content)", async () => {
      const app = createApp(db, env);
      const sessionId = insertRawSession(db, "evening", iso(2026, 8, 13, 19, 0), iso(2026, 8, 13, 19, 30));
      insertRawDailyReport(db, "2026-08-13", "# 日報 2026-08-13", sessionId, iso(2026, 8, 13, 19, 30), iso(2026, 8, 13, 19, 30));
      const sessionId2 = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawDailyReport(db, "2026-08-14", "# 日報 2026-08-14", sessionId2, iso(2026, 8, 14, 19, 30), iso(2026, 8, 14, 19, 30));

      const res = await app.request("/api/reports");

      expect(res.status).toBe(200);
      const body = await readJson<DailyReportSummary[]>(res);
      expect(body.map((r) => r.date)).toEqual(["2026-08-14", "2026-08-13"]);
      expect(body[0]).toEqual({
        date: "2026-08-14",
        created_at: iso(2026, 8, 14, 19, 30),
        updated_at: iso(2026, 8, 14, 19, 30),
      });
      expect(body[0]).not.toHaveProperty("content");
    });

    it("does not list the same date twice after regeneration", async () => {
      const app = createApp(db, env);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0));
      const session = await readJson<{ id: number }>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      insertRawMessage(db, session.id, "user", "報告です", iso(2026, 8, 14, 19, 1));
      await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

      await app.request("/api/reports/generate", { method: "POST" });
      await app.request("/api/reports/generate", { method: "POST" });

      const res = await app.request("/api/reports");
      const body = await readJson<DailyReportSummary[]>(res);
      expect(body).toHaveLength(1);
    });
  });

  describe("GET /api/reports/:date", () => {
    it("returns the report body for an existing date", async () => {
      const app = createApp(db, env);
      const sessionId = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawDailyReport(
        db,
        "2026-08-14",
        "# 日報 2026-08-14",
        sessionId,
        iso(2026, 8, 14, 19, 30),
        iso(2026, 8, 14, 19, 30),
      );

      const res = await app.request("/api/reports/2026-08-14");

      expect(res.status).toBe(200);
      const body = await readJson<DailyReport>(res);
      expect(body).toMatchObject({
        date: "2026-08-14",
        content: "# 日報 2026-08-14",
        evening_session_id: sessionId,
        created_at: iso(2026, 8, 14, 19, 30),
        updated_at: iso(2026, 8, 14, 19, 30),
      });
    });

    it("returns 404 with code report_not_found when the date has no report", async () => {
      const app = createApp(db, env);

      const res = await app.request("/api/reports/2026-08-14");

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBodyWithCode>(res);
      expect(body.code).toBe("report_not_found");
      expect(typeof body.error).toBe("string");
    });
  });

  describe("POST /api/reports/generate", () => {
    it("generates and saves today's report, returning the same shape as GET /:date", async () => {
      const app = createApp(db, env);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0));
      const session = await readJson<{ id: number }>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      insertRawMessage(db, session.id, "user", "報告です", iso(2026, 8, 14, 19, 1));
      await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

      const res = await app.request("/api/reports/generate", { method: "POST" });

      expect(res.status).toBe(200);
      const body = await readJson<DailyReport>(res);
      expect(body.date).toBe("2026-08-14");
      expect(body.evening_session_id).toBe(session.id);
      expect(typeof body.content).toBe("string");
      expect(typeof body.created_at).toBe("string");
      expect(typeof body.updated_at).toBe("string");
    });

    it("returns 409 with code evening_session_required when the prerequisite is not met", async () => {
      const app = createApp(db, env);

      const res = await app.request("/api/reports/generate", { method: "POST" });

      expect(res.status).toBe(409);
      const body = await readJson<ErrorBodyWithCode>(res);
      expect(body.code).toBe("evening_session_required");
      expect(body.error).toBe("夕会を完了すると日報を生成できます");
    });

    it("overwrites the same day's report on regeneration", async () => {
      const app = createApp(db, env);
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0));
      const session = await readJson<{ id: number }>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      insertRawMessage(db, session.id, "user", "報告です", iso(2026, 8, 14, 19, 1));
      await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

      const first = await readJson<DailyReport>(
        await app.request("/api/reports/generate", { method: "POST" }),
      );

      requestVerdictMock.mockResolvedValue({
        called: true,
        result: {
          valid: true,
          data: {
            reportSummary: "更新後の要点",
            bossComment: "講評",
            keyDecisions: "なし",
            carryOver: "なし",
          },
        },
      });
      const second = await readJson<DailyReport>(
        await app.request("/api/reports/generate", { method: "POST" }),
      );

      expect(second.id).toBe(first.id);
      expect(second.content).toContain("更新後の要点");
      // フォールバック値 ("__none__") で黙って通過しないよう、まず抽出結果が
      // 存在することを検証してから比較する（CodeRabbit 指摘）。
      const firstSummaryLine = first.content.match(/報告の要点: .+/)?.[0];
      expect(firstSummaryLine).toBeDefined();
      expect(second.content).not.toContain(firstSummaryLine);
    });

    // Issue #297 (AC-2): 23:50 開始 → 翌 00:30 終了の夕会は、当日
    // (toDateKey(now)) 基準の既定解決だと日付が変わった瞬間に見失う
    // （これが本チケットの発端の欠陥）。`date`／`eveningSessionId`
    // パラメータで対象夕会を明示すれば、`now` に依存せず開始日基準で解決
    // できることを HTTP 経路（app.request 経由）で担保する。
    describe("regenerating an evening session that crossed midnight (AC-1, AC-2)", () => {
      async function setUpCrossMidnightSession(app: Hono): Promise<{ sessionId: number }> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 14, 23, 50)); // 2026-08-14 23:50
        const session = await readJson<{ id: number }>(
          await app.request("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "evening" }),
          }),
        );
        insertRawMessage(db, session.id, "user", "報告です", iso(2026, 8, 14, 23, 51));
        vi.setSystemTime(new Date(2026, 7, 15, 0, 30)); // 2026-08-15 00:30 (翌日)
        await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });
        vi.setSystemTime(new Date(2026, 7, 15, 0, 31)); // 2026-08-15 00:31 (再生成時点)
        return { sessionId: session.id };
      }

      it("fails with the default (no-param) resolution once the date has rolled over — the bug this ticket fixes", async () => {
        const app = createApp(db, env);
        await setUpCrossMidnightSession(app);

        const res = await app.request("/api/reports/generate", { method: "POST" });

        expect(res.status).toBe(409);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("evening_session_required");
      });

      it("resolves the target evening session by started_at's local calendar day via the date param", async () => {
        const app = createApp(db, env);
        const { sessionId } = await setUpCrossMidnightSession(app);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "2026-08-14" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<DailyReport>(res);
        expect(body.date).toBe("2026-08-14");
        expect(body.evening_session_id).toBe(sessionId);
      });

      it("resolves the target evening session directly via the eveningSessionId param", async () => {
        const app = createApp(db, env);
        const { sessionId } = await setUpCrossMidnightSession(app);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eveningSessionId: sessionId }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<DailyReport>(res);
        expect(body.date).toBe("2026-08-14");
        expect(body.evening_session_id).toBe(sessionId);
      });

      it("prioritizes eveningSessionId over date when both are provided", async () => {
        const app = createApp(db, env);
        const { sessionId } = await setUpCrossMidnightSession(app);

        // date は該当する夕会が無い日を指定する（date 単体なら 409 になる
        // はず）。eveningSessionId が優先されるため、date は無視されて
        // sessionId の夕会 (2026-08-14) の日報が生成されることを確認する。
        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eveningSessionId: sessionId, date: "2026-08-01" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<DailyReport>(res);
        expect(body.date).toBe("2026-08-14");
        expect(body.evening_session_id).toBe(sessionId);
      });
    });

    describe("invalid parameters", () => {
      it("returns 400 invalid_request when eveningSessionId is not an integer", async () => {
        const app = createApp(db, env);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eveningSessionId: "abc" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("invalid_request");
      });

      it("returns 400 invalid_request when date is not in YYYY-MM-DD format", async () => {
        const app = createApp(db, env);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "2026/08/14" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("invalid_request");
      });

      it("returns 400 invalid_request when date is not a real calendar day", async () => {
        const app = createApp(db, env);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "2026-02-30" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("invalid_request");
      });

      it("returns 400 invalid_request when the body cannot be parsed as JSON", async () => {
        const app = createApp(db, env);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not valid json",
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("invalid_request");
      });

      it("returns 400 invalid_request when the body is valid JSON but not an object", async () => {
        const app = createApp(db, env);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([1, 2, 3]),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("invalid_request");
      });

      // 以下2件は「今日」の有効な夕会をあらかじめ用意し、パラメータ無しなら
      // 200 になることを確認したうえで、不正な eveningSessionId/date を渡すと
      // （既定の当日解決へ黙って読み替えられず）409 になることを確かめる。
      // 有効な夕会が存在しない状態だけで検証すると、既定解決も同じ 409 に
      // なるため、パラメータが実際に評価されたのか区別できない。
      async function setUpTodaysValidSession(app: Hono): Promise<void> {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 14, 19, 0));
        const session = await readJson<{ id: number }>(
          await app.request("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "evening" }),
          }),
        );
        insertRawMessage(db, session.id, "user", "報告です", iso(2026, 8, 14, 19, 1));
        await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });
      }

      it("returns 409 evening_session_required when eveningSessionId does not reference an existing session, even though today's default session exists", async () => {
        const app = createApp(db, env);
        await setUpTodaysValidSession(app);

        const sanity = await app.request("/api/reports/generate", { method: "POST" });
        expect(sanity.status).toBe(200);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eveningSessionId: 999999 }),
        });

        expect(res.status).toBe(409);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("evening_session_required");
      });

      it("returns 409 evening_session_required when date has no matching evening session, even though today's default session exists", async () => {
        const app = createApp(db, env);
        await setUpTodaysValidSession(app);

        const sanity = await app.request("/api/reports/generate", { method: "POST" });
        expect(sanity.status).toBe(200);

        const res = await app.request("/api/reports/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: "2026-08-01" }),
        });

        expect(res.status).toBe(409);
        const body = await readJson<ErrorBodyWithCode>(res);
        expect(body.code).toBe("evening_session_required");
      });
    });
  });
});
