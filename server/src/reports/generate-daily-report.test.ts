import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { SessionType } from "../sessions/session.js";
import { FALLBACK_EVENING_SUMMARY_NOTE } from "./render-daily-report.js";
import { EVENING_OPENING_FALLBACK } from "../sessions/meeting-opening.js";

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

const { generateDailyReport } = await import("./generate-daily-report.js");

function calledWithValid(data: {
  reportSummary: string;
  bossComment: string;
  keyDecisions: string;
  carryOver: string;
}) {
  return { called: true as const, result: { valid: true as const, data } };
}

function calledWithInvalid(error: string) {
  return { called: true as const, result: { valid: false as const, error } };
}

function notCalled() {
  return { called: false as const };
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

function insertRawDoneTask(
  db: Database.Database,
  title: string,
  createdAt: string,
  completedAt: string,
): void {
  db.prepare(
    `INSERT INTO tasks (title, status, created_at, updated_at, completed_at)
     VALUES (?, 'done', ?, ?, ?)`,
  ).run(title, createdAt, createdAt, completedAt);
}

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

describe("generateDailyReport", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    requestVerdictMock.mockReset();
    createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function reportRowCount(): number {
    const row = db.prepare("SELECT COUNT(*) as count FROM daily_reports").get() as {
      count: number;
    };
    return row.count;
  }

  describe("前提条件チェック", () => {
    it("当日の夕会が存在しない場合、evening_session_required を返し daily_reports に行が作られない", async () => {
      const now = new Date(2026, 7, 14, 21, 0);

      const result = await generateDailyReport(db, env, now);

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
      expect(requestVerdictMock).not.toHaveBeenCalled();
    });

    it("当日の夕会が未終了（ended_at が null）の場合、evening_session_required を返し daily_reports に行が作られない", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), null);
      insertRawMessage(db, sessionId, "user", "報告です", iso(2026, 8, 14, 19, 1));

      const result = await generateDailyReport(db, env, now);

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
    });

    it("role=user のメッセージが0件の場合、evening_session_required を返し daily_reports に行が作られない", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "boss", "夕会を始めよう", iso(2026, 8, 14, 19, 1));

      const result = await generateDailyReport(db, env, now);

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
    });

    // AC-17 (Issue #271): the meeting-opening line (`role: "boss"`,
    // `sessions/meeting-opening.ts`) is the only message a freshly-opened
    // evening session has until the user replies. It must not, by itself,
    // satisfy the "role = user" prerequisite (ADR 0008 決定1) — otherwise a
    // user could end an evening session having said nothing and still get a
    // daily report. Uses the real fallback text (not an arbitrary string) so
    // this test breaks if the two modules' contracts ever drift apart.
    it("AC-17: 夕会に開始ひとこと（role=boss）だけがある状態では前提条件を満たさない", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "boss", EVENING_OPENING_FALLBACK, iso(2026, 8, 14, 19, 0, 1));

      const result = await generateDailyReport(db, env, now);

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
      expect(requestVerdictMock).not.toHaveBeenCalled();
    });
  });

  describe("正常系", () => {
    it("4値がテンプレートの「夕会サマリ」に反映され daily_reports に UPSERT される", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "タスクAを完了した", iso(2026, 8, 14, 19, 1));
      insertRawMessage(db, sessionId, "boss", "よくやった", iso(2026, 8, 14, 19, 2));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({
          reportSummary: "タスクAを完了した",
          bossComment: "よくやった",
          keyDecisions: "本日のノルマは資料作成完了とする",
          carryOver: "タスクBを明日に持ち越す",
        }),
      );

      const result = await generateDailyReport(db, env, now);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.date).toBe("2026-08-14");
      expect(result.report.evening_session_id).toBe(sessionId);
      expect(result.report.content).toContain("- 報告の要点: タスクAを完了した");
      expect(result.report.content).toContain("- ボスの講評: よくやった");
      expect(result.report.content).toContain("- 決定の要点: 本日のノルマは資料作成完了とする");
      expect(result.report.content).toContain("- 翌日への持ち越し: タスクBを明日に持ち越す");
      expect(reportRowCount()).toBe(1);
    });

    it("持ち越しなし: LLM が「なし」相当を返すと「翌日への持ち越し: なし」が出力される", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "今日は全部終わった", iso(2026, 8, 14, 19, 1));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({
          reportSummary: "全タスク完了",
          bossComment: "満点だ",
          keyDecisions: "なし",
          carryOver: "なし",
        }),
      );

      const result = await generateDailyReport(db, env, now);

      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.content).toContain("- 翌日への持ち越し: なし");
    });

    it("決定なし: active 決定が0件でも生成は成功し、LLM が「なし」を返すと「決定の要点: なし」が出力される", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "今日は決定なし", iso(2026, 8, 14, 19, 1));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({
          reportSummary: "特に進捗なし",
          bossComment: "明日に期待する",
          keyDecisions: "なし",
          carryOver: "なし",
        }),
      );

      const result = await generateDailyReport(db, env, now);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.content).toContain("- 決定の要点: なし");
    });

    it("当日の active 決定一覧が抽出ステップ（extractEveningSummary 経由の requestVerdict 入力）へ渡される", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "タスクAを完了した", iso(2026, 8, 14, 19, 1));
      db.prepare(
        `INSERT INTO decisions (session_id, content, status, created_at) VALUES (?, ?, 'active', ?)`,
      ).run(sessionId, "本日のノルマは資料作成完了とする", iso(2026, 8, 14, 10, 0));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({
          reportSummary: "a",
          bossComment: "b",
          keyDecisions: "本日のノルマは資料作成完了とする",
          carryOver: "なし",
        }),
      );

      await generateDailyReport(db, env, now);

      const [, request] = requestVerdictMock.mock.calls[0];
      const userMessage = request.messages[0].content as string;
      expect(userMessage).toContain("本日のノルマは資料作成完了とする");
    });
  });

  describe("フォールバック", () => {
    it.each([
      ["LLM 呼び出し失敗", () => requestVerdictMock.mockRejectedValue(new Error("network error"))],
      ["ツール未呼び出し", () => requestVerdictMock.mockResolvedValue(notCalled())],
      ["不正形（必須欠落・空文字）", () => requestVerdictMock.mockResolvedValue(calledWithInvalid("carry_over is required"))],
    ])("%s の場合でも例外を投げず、フォールバック日報が保存され「夕会サマリ」が固定文言1行のみになる", async (_label, setupMock) => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "報告です", iso(2026, 8, 14, 19, 1));
      setupMock();

      const result = await generateDailyReport(db, env, now);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      const summarySection = result.report.content.split("## 夕会サマリ")[1].split("##")[0];
      expect(summarySection).toContain(FALLBACK_EVENING_SUMMARY_NOTE);
      expect(summarySection).not.toContain("- 報告の要点:");
      expect(summarySection).not.toContain("- ボスの講評:");
      expect(summarySection).not.toContain("- 決定の要点:");
      expect(summarySection).not.toContain("- 翌日への持ち越し:");
      expect(reportRowCount()).toBe(1);
    });
  });

  describe("タイムアウト", () => {
    it("上限時間を渡した状態で LLM 応答が遅い場合、フォールバック日報が保存される（フェイクタイマーで決定的に）", async () => {
      vi.useFakeTimers();
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "報告です", iso(2026, 8, 14, 19, 1));
      const neverSettles = new Promise(() => {});
      requestVerdictMock.mockReturnValue(neverSettles);

      const resultPromise = generateDailyReport(db, env, now, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.content).toContain(FALLBACK_EVENING_SUMMARY_NOTE);
      expect(reportRowCount()).toBe(1);
    });
  });

  describe("再生成", () => {
    it("同日に2回呼ぶと daily_reports の同日行が上書きされ、行数が増えない", async () => {
      const now = new Date(2026, 7, 14, 21, 0);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 19, 0),
        iso(2026, 8, 14, 19, 30),
      );
      insertRawMessage(db, sessionId, "user", "1回目の報告", iso(2026, 8, 14, 19, 1));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({ reportSummary: "1回目", bossComment: "b", keyDecisions: "なし", carryOver: "なし" }),
      );

      const first = await generateDailyReport(db, env, now);
      requestVerdictMock.mockResolvedValue(
        calledWithValid({ reportSummary: "2回目", bossComment: "b", keyDecisions: "なし", carryOver: "なし" }),
      );
      const second = await generateDailyReport(db, env, now);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("expected ok results");
      expect(second.report.id).toBe(first.report.id);
      expect(second.report.content).toContain("2回目");
      expect(second.report.content).not.toContain("- 報告の要点: 1回目");
      expect(reportRowCount()).toBe(1);
    });
  });

  describe("日付境界", () => {
    it("23:50開始・翌00:30終了の夕会に対して生成すると、date と表題が開始日になる", async () => {
      const now = new Date(2026, 7, 14, 23, 55);
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 23, 50),
        iso(2026, 8, 15, 0, 30),
      );
      insertRawMessage(db, sessionId, "user", "日をまたぐ夕会の報告", iso(2026, 8, 14, 23, 51));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({ reportSummary: "a", bossComment: "b", keyDecisions: "なし", carryOver: "なし" }),
      );

      const result = await generateDailyReport(db, env, now);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.date).toBe("2026-08-14");
      expect(result.report.content).toContain("# 日報 2026-08-14（金）");
    });
  });

  describe("セッション指定（eveningSessionId）", () => {
    it("日をまたぐ夕会をセッション指定で生成すると、now が翌日相当（終了直後の実時刻）でも date と表題が開始日になり、集計対象も開始日の範囲になる（夕会終了フックが通る経路）", async () => {
      const sessionId = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 23, 50),
        iso(2026, 8, 15, 0, 30),
      );
      insertRawMessage(db, sessionId, "user", "日をまたぐ夕会の報告", iso(2026, 8, 14, 23, 51));
      // 開始日（8/14）に完了したタスクは集計対象、終了後（8/15）に完了した
      // タスクは対象外になることを、日付境界が正しく解決されている証拠とする。
      insertRawDoneTask(db, "8/14に完了したタスク", iso(2026, 8, 14, 10, 0), iso(2026, 8, 14, 18, 0));
      insertRawDoneTask(db, "8/15に完了したタスク", iso(2026, 8, 15, 9, 0), iso(2026, 8, 15, 9, 0));
      requestVerdictMock.mockResolvedValue(
        calledWithValid({ reportSummary: "a", bossComment: "b", keyDecisions: "なし", carryOver: "なし" }),
      );

      // 夕会終了フック（#109）を模して、now は終了直後の実時刻（翌日 00:30
      // 相当）を渡す。生成サービスは now ではなく指定されたセッションの
      // started_at から対象暦日を解決する。
      const nowAfterEnding = new Date(2026, 7, 15, 0, 31);

      const result = await generateDailyReport(db, env, nowAfterEnding, {
        eveningSessionId: sessionId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.report.date).toBe("2026-08-14");
      expect(result.report.content).toContain("# 日報 2026-08-14（金）");
      expect(result.report.content).toContain("- [x] 8/14に完了したタスク");
      expect(result.report.content).not.toContain("8/15に完了したタスク");
    });

    it("eveningSessionId が存在しないセッションを指す場合、evening_session_required を返し daily_reports に行が作られない", async () => {
      const now = new Date(2026, 7, 15, 0, 31);

      const result = await generateDailyReport(db, env, now, { eveningSessionId: 9999 });

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
    });

    it("eveningSessionId が type=evening ではないセッションを指す場合、evening_session_required を返す", async () => {
      const now = new Date(2026, 7, 15, 0, 31);
      const morningSessionId = insertRawSession(
        db,
        "morning",
        iso(2026, 8, 14, 8, 0),
        iso(2026, 8, 14, 8, 30),
      );
      insertRawMessage(db, morningSessionId, "user", "朝会の報告", iso(2026, 8, 14, 8, 1));

      const result = await generateDailyReport(db, env, now, {
        eveningSessionId: morningSessionId,
      });

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
    });

    it("eveningSessionId 指定時も前提条件（終了済み・role=user発言1件以上）は維持される", async () => {
      const now = new Date(2026, 7, 15, 0, 31);
      const unendedSessionId = insertRawSession(db, "evening", iso(2026, 8, 14, 23, 50), null);
      insertRawMessage(db, unendedSessionId, "user", "報告です", iso(2026, 8, 14, 23, 51));

      const result = await generateDailyReport(db, env, now, {
        eveningSessionId: unendedSessionId,
      });

      expect(result).toEqual({ ok: false, code: "evening_session_required" });
      expect(reportRowCount()).toBe(0);
    });
  });
});
