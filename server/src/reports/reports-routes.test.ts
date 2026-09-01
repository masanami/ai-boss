import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  });
});
