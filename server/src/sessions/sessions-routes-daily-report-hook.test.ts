import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import type { Session } from "./session.js";
import type { SessionType } from "./session.js";

// docs/features/daily-report.md「機能全体の設計 > 夕会終了フック」の受入基準
// 群（初回遷移のみ発火・朝会/随時では発火しない・生成失敗でも終了APIは200・
// 前提条件未達でも終了APIは200）を検証する。#109 完了条件のテスト5〜9。
//
// Claude API は必ずモック（CLAUDE.md「テスト方針」）。`generateDailyReport`
// 自体は既定で実装（`../reports/generate-daily-report.js`）へ委譲しつつ、
// 呼び出し回数を計測できるよう spy でラップする。例外系のテストのみ
// `mockRejectedValueOnce` で一時的に上書きする。

const { createClaudeClientMock, requestVerdictMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  requestVerdictMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    requestVerdict: requestVerdictMock,
  };
});

const { generateDailyReportMock } = vi.hoisted(() => ({
  generateDailyReportMock: vi.fn(),
}));

vi.mock("../reports/generate-daily-report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../reports/generate-daily-report.js")>();
  generateDailyReportMock.mockImplementation(actual.generateDailyReport);
  return { ...actual, generateDailyReport: generateDailyReportMock };
});

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function postSession(app: ReturnType<typeof createApp>, type: SessionType) {
  return app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
}

function insertUserMessage(db: Database.Database, sessionId: number, content: string): void {
  db.prepare(
    "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)",
  ).run(sessionId, content, new Date().toISOString());
}

function reportRowCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM daily_reports").get() as {
    count: number;
  };
  return row.count;
}

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

describe("evening session end -> daily report generation hook", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
    requestVerdictMock.mockResolvedValue({
      called: true,
      result: {
        valid: true,
        data: { reportSummary: "要点", bossComment: "講評", carryOver: "なし" },
      },
    });
    generateDailyReportMock.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  it("saves the report when an evening session with a user message ends (test 5)", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));
    insertUserMessage(db, session.id, "報告です");

    const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
    expect(generateDailyReportMock).toHaveBeenCalledWith(
      db,
      env,
      expect.any(Date),
      expect.objectContaining({ eveningSessionId: session.id, timeoutMs: 20_000 }),
    );
    expect(reportRowCount(db)).toBe(1);
    const report = db.prepare("SELECT * FROM daily_reports").get() as {
      evening_session_id: number;
    };
    expect(report.evening_session_id).toBe(session.id);
  });

  it("does not re-invoke generation when an already-ended evening session is ended again (test 6)", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));
    insertUserMessage(db, session.id, "報告です");

    const first = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });
    const second = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
    expect(reportRowCount(db)).toBe(1);
  });

  it("returns 200 from the end API even when generation throws (test 7)", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));
    insertUserMessage(db, session.id, "報告です");
    generateDailyReportMock.mockRejectedValueOnce(new Error("boom"));

    const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await readJson<Session>(res);
    expect(body.ended_at).not.toBeNull();
    expect(reportRowCount(db)).toBe(0);
  });

  it("does not save a report and still returns 200 when the evening session has zero user messages (test 8)", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));

    const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
    expect(requestVerdictMock).not.toHaveBeenCalled();
    expect(reportRowCount(db)).toBe(0);
  });

  it.each(["morning", "adhoc"] as const)(
    "does not invoke generateDailyReport when a %s session ends (test 9)",
    async (type) => {
      const app = createApp(db, env);
      const session = await readJson<Session>(await postSession(app, type));

      const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

      expect(res.status).toBe(200);
      expect(generateDailyReportMock).not.toHaveBeenCalled();
      expect(reportRowCount(db)).toBe(0);
    },
  );
});
