import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import type { Session } from "./session.js";
import type { SessionType } from "./session.js";

// 夕会終了フックのテスト。ここで固定するのは
// 「初回遷移でのみ発火（再終了で再発火しない）」「要約保存と日報生成が
// 独立して走る」「生成失敗でも終了APIは200」「前提条件未達でも終了APIは200」
// 「朝会/随時では発火しない」。#109 完了条件のテスト5〜9。
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

// `POST /:id/end` drives two independent side effects since Issue #96 and
// Issue #100 were merged: the session summary and the daily report. Stubbed
// here (rather than driven through the real LLM path) so the coexistence
// test below can assert both outcomes deterministically.
const { generateSessionSummaryMock } = vi.hoisted(() => ({
  generateSessionSummaryMock: vi.fn(),
}));

vi.mock("./session-summary.js", () => ({
  generateSessionSummary: generateSessionSummaryMock,
}));

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
    // 現在時刻を固定する。`toFake: ["Date"]` に限定し setTimeout は fake 化
    // しない（このルートが `await` する日報生成の内部タイマー・LLM 呼び出し
    // 待ちまで止めてテストをハングさせないため。web/src/AppLayout.test.tsx
    // と同じ書き方 — CodeRabbit 指摘）。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 14, 19, 0, 0));

    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
    requestVerdictMock.mockResolvedValue({
      called: true,
      result: {
        valid: true,
        data: { reportSummary: "要点", bossComment: "講評", keyDecisions: "なし", carryOver: "なし" },
      },
    });
    generateDailyReportMock.mockClear();
    generateSessionSummaryMock.mockReset();
    generateSessionSummaryMock.mockResolvedValue("夕会の要約");
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
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

  // main への追従マージ（Issue #96 と #100 の合流）の回帰テスト。`POST /:id/end`
  // は要約保存（#96）と日報生成（#100）の 2 つを行う。片方が早期 return して
  // もう片方を飛ばす実装に戻ると、このテストだけが落ちる。
  it("saves the session summary AND generates the daily report when an evening session ends", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));
    insertUserMessage(db, session.id, "報告です");

    const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(res.status).toBe(200);

    // #96: 要約が保存され、レスポンスにも反映される
    expect(generateSessionSummaryMock).toHaveBeenCalledTimes(1);
    const body = await readJson<Session>(res);
    expect(body.summary).toBe("夕会の要約");
    const stored = db
      .prepare("SELECT summary FROM sessions WHERE id = ?")
      .get(session.id) as { summary: string | null };
    expect(stored.summary).toBe("夕会の要約");

    // #100: 同じリクエストで日報も生成されている
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
    expect(reportRowCount(db)).toBe(1);
  });

  // 2 つのガードは別条件であり、片方を流用して他方を壊してはならない。
  // 要約済み（summary あり）の未終了夕会を終了すると、要約は再生成されないが
  // ended_at は初回遷移なので日報は生成される。
  it("still generates the daily report when the summary is skipped because one already exists", async () => {
    const app = createApp(db, env);
    const session = await readJson<Session>(await postSession(app, "evening"));
    insertUserMessage(db, session.id, "報告です");
    db.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run("既存の要約", session.id);

    const res = await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(generateSessionSummaryMock).not.toHaveBeenCalled();
    expect(generateDailyReportMock).toHaveBeenCalledTimes(1);
    expect(reportRowCount(db)).toBe(1);
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
