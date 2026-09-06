import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { Task } from "../tasks/task.js";
import {
  insertNotification,
  listNotificationsSince,
} from "../notifications/notifications-repository.js";
import { toNotificationHistory } from "../scheduler/notification-history.js";
import { resolveEscalation } from "../detection/escalation.js";
import { getActiveBreak } from "../detection/break-overrun.js";
import { listEventsSince } from "./activity-events-repository.js";
import { DEFAULT_DETECTION_SETTINGS } from "../detection/detection-types.js";
import type { ActivityEvent } from "./activity-event.js";

/**
 * Issue #352: regression-fixes the behavior of the "layers left untouched"
 * (通知・検知エンジン・日報) when a backdated `activity_events` row is
 * recorded via `POST /api/checkins`'s `occurred_at` (#350). These tests
 * exercise the real API endpoint (never a direct DB insert for the backdated
 * event itself) so the fixture matches how a user would actually record a
 * backdated checkin; only *pre-existing* history fixtures use direct inserts,
 * mirroring reports-routes.test.ts / checkins-routes.test.ts's own patterns.
 */

// Report generation (AC-16) drives the same LLM call sites as
// reports-routes.test.ts and must mock them the same way, or the real
// dispatch/retry path hangs under vi.useFakeTimers() (see that file's
// extensive comments on createBossMessageMock / generateSessionSummaryMock).
const { createClaudeClientMock, requestVerdictMock, createBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  requestVerdictMock: vi.fn(),
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

const { generateSessionSummaryMock } = vi.hoisted(() => ({
  generateSessionSummaryMock: vi.fn(),
}));

vi.mock("../sessions/session-summary.js", () => ({
  generateSessionSummary: generateSessionSummaryMock,
}));

const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };

// Local (not UTC) constructor per ADR 0007 決定5 — pins "today" at
// 2026-07-05 so the today-boundary checks in checkins-routes.ts stay
// TZ-independent (npm run test:tz).
const NOW = new Date(2026, 6, 5, 14, 0, 0, 0);

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function postCheckin(app: Hono, body: Record<string, unknown>) {
  return app.request("/api/checkins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("backdated checkins: effect on notifications / escalation / break detection (#352)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe("判断1: 送信済み通知は撤回・変更されない (AC-13)", () => {
    it("leaves an existing notification row unchanged after a backdated checkin is recorded", async () => {
      const sentAt = new Date(2026, 6, 5, 9, 0, 0, 0);
      vi.setSystemTime(sentAt);
      const inserted = insertNotification(db, {
        type: "unstarted_reminder",
        rule_key: "unstarted:1",
        escalation_level: 2,
        body: "着手してください",
      });
      vi.setSystemTime(NOW);

      const app = createApp(db);
      const res = await postCheckin(app, {
        type: "checkin",
        occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
      });
      expect(res.status).toBe(201);

      const rows = listNotificationsSince(db, new Date(0).toISOString());
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(inserted);
    });
  });

  describe("判断2: エスカレーションは既存規則に委ねる (AC-14 / AC-15)", () => {
    it("resets resolveEscalation to level 1 when the backdated signal is after the last notification's sent_at (AC-14)", async () => {
      const sentAt = new Date(2026, 6, 5, 9, 0, 0, 0);
      vi.setSystemTime(sentAt);
      insertNotification(db, {
        type: "unstarted_reminder",
        rule_key: "unstarted:1",
        escalation_level: 2,
        body: "着手してください",
      });
      vi.setSystemTime(NOW);

      const app = createApp(db);
      const res = await postCheckin(app, {
        type: "checkin",
        // After sentAt (09:00), before NOW (14:00): a genuine backdated
        // activity signal the escalation engine should see as "activity
        // since the last notification".
        occurred_at: new Date(2026, 6, 5, 10, 0, 0, 0).toISOString(),
      });
      expect(res.status).toBe(201);

      const notifications = toNotificationHistory(
        listNotificationsSince(db, new Date(0).toISOString()),
      );
      const activityEvents = listEventsSince(db, new Date(0).toISOString());
      const result = resolveEscalation(
        "unstarted:1",
        NOW,
        notifications,
        activityEvents,
        DEFAULT_DETECTION_SETTINGS.escalation,
      );

      // Without the reset this would escalate past level 1 (5h elapsed since
      // sentAt, well past every interval in DEFAULT_DETECTION_SETTINGS), so
      // level 1 here specifically pins down the reset behavior.
      expect(result).toEqual({ escalationLevel: 1 });
    });

    it("does not reset resolveEscalation when the backdated signal is before the last notification's sent_at (AC-15)", async () => {
      const sentAt = new Date(2026, 6, 5, 10, 0, 0, 0);
      vi.setSystemTime(sentAt);
      insertNotification(db, {
        type: "unstarted_reminder",
        rule_key: "unstarted:1",
        escalation_level: 1,
        body: "着手してください",
      });
      // Only 5 minutes elapsed by the time the checkin is recorded — short
      // of the 15min level1->2 interval, so a correctly-unreset evaluation
      // returns null (no fire) rather than escalating.
      const shortlyAfterSentAt = new Date(2026, 6, 5, 10, 5, 0, 0);
      vi.setSystemTime(shortlyAfterSentAt);

      const app = createApp(db);
      const res = await postCheckin(app, {
        type: "checkin",
        // Before sentAt (10:00): must NOT be treated as a reset signal.
        occurred_at: new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(),
      });
      expect(res.status).toBe(201);

      const notifications = toNotificationHistory(
        listNotificationsSince(db, new Date(0).toISOString()),
      );
      const activityEvents = listEventsSince(db, new Date(0).toISOString());
      const result = resolveEscalation(
        "unstarted:1",
        shortlyAfterSentAt,
        notifications,
        activityEvents,
        DEFAULT_DETECTION_SETTINGS.escalation,
      );

      expect(result).toBeNull();
    });
  });

  describe("判断3: 生成済み日報は自動再生成されない (AC-16)", () => {
    beforeEach(() => {
      createClaudeClientMock.mockReset();
      requestVerdictMock.mockReset();
      createBossMessageMock.mockReset();
      generateSessionSummaryMock.mockReset();
      createClaudeClientMock.mockReturnValue({ backend: "api", client: {} });
      createBossMessageMock.mockResolvedValue({ content: [] });
      requestVerdictMock.mockResolvedValue({
        called: true,
        result: {
          valid: true,
          data: {
            reportSummary: "要点",
            bossComment: "講評",
            keyDecisions: "なし",
            carryOver: "なし",
          },
        },
      });
      generateSessionSummaryMock.mockResolvedValue("夕会の要約");
    });

    it("returns the same GET /api/reports/:date content before and after a backdated checkin", async () => {
      const app = createApp(db, env);

      // Evening session -> generate today's report, mirroring
      // reports-routes.test.ts's own fixture.
      const session = await readJson<{ id: number }>(
        await app.request("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "evening" }),
        }),
      );
      db.prepare(
        "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      ).run(session.id, "user", "報告です", new Date(2026, 6, 5, 14, 1, 0, 0).toISOString());
      await app.request(`/api/sessions/${session.id}/end`, { method: "POST" });
      const generateRes = await app.request("/api/reports/generate", { method: "POST" });
      expect(generateRes.status).toBe(200);

      const before = await readJson<{ date: string; content: string }>(
        await app.request("/api/reports/2026-07-05"),
      );
      // Codex 指摘（PR #355）: 内容の等値比較だけでは、チェックイン中に
      // generateDailyReport を呼んで upsert する実装でも同じ行になって pass
      // してしまう（checkin は日報に描画されるフィールドを変えず、LLM モック
      // は定数を返し、時計は固定）。再生成の副作用そのもの＝日報生成が呼ぶ
      // LLM 抽出（requestVerdict）の呼び出し回数と daily_reports の行数が
      // チェックイン前後で増えないことを観測する。
      const verdictCallsAfterGenerate = requestVerdictMock.mock.calls.length;
      expect(verdictCallsAfterGenerate).toBeGreaterThan(0);
      const reportRowsBefore = db
        .prepare("SELECT COUNT(*) AS n FROM daily_reports")
        .get() as { n: number };

      const checkinRes = await postCheckin(app, {
        type: "checkin",
        occurred_at: new Date(2026, 6, 5, 9, 0, 0, 0).toISOString(),
      });
      expect(checkinRes.status).toBe(201);

      const after = await readJson<{ date: string; content: string }>(
        await app.request("/api/reports/2026-07-05"),
      );

      expect(after).toEqual(before);
      expect(requestVerdictMock.mock.calls.length).toBe(verdictCallsAfterGenerate);
      const reportRowsAfter = db
        .prepare("SELECT COUNT(*) AS n FROM daily_reports")
        .get() as { n: number };
      expect(reportRowsAfter.n).toBe(reportRowsBefore.n);
    });
  });

  describe("判断5 調査結果: break_end 無しの後追い break_start は継続中の休憩として扱われる (AC-17)", () => {
    it("getActiveBreak still returns the backdated break_start after a later task_start", async () => {
      const app = createApp(db);
      const task: Task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });

      const breakStartAt = new Date(2026, 6, 5, 10, 0, 0, 0).toISOString();
      const breakRes = await postCheckin(app, {
        type: "break_start",
        occurred_at: breakStartAt,
      });
      expect(breakRes.status).toBe(201);

      const taskStartAt = new Date(2026, 6, 5, 11, 0, 0, 0).toISOString();
      const taskStartRes = await postCheckin(app, {
        type: "task_start",
        task_id: task.id,
        occurred_at: taskStartAt,
      });
      expect(taskStartRes.status).toBe(201);

      const activityEvents: ActivityEvent[] = listEventsSince(db, new Date(0).toISOString());
      const activeBreak = getActiveBreak(activityEvents);

      expect(activeBreak).toBeDefined();
      expect(activeBreak?.type).toBe("break_start");
      expect(activeBreak?.created_at).toBe(breakStartAt);
    });
  });
});
