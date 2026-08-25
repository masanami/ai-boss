import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import type { Session, SessionType } from "../sessions/session.js";
import { collectDailyReportData } from "./collect-daily-report-data.js";

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
): Session {
  const result = db
    .prepare("INSERT INTO sessions (type, started_at, ended_at) VALUES (?, ?, ?)")
    .run(type, startedAt, endedAt);
  return db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Session;
}

function insertRawTask(
  db: Database.Database,
  opts: {
    title: string;
    status: "todo" | "in_progress" | "done" | "dropped";
    createdAt: string;
    completedAt?: string | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO tasks (title, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.title, opts.status, opts.createdAt, opts.createdAt, opts.completedAt ?? null);
  return Number(result.lastInsertRowid);
}

function insertRawActivityEvent(
  db: Database.Database,
  opts: {
    type: "task_start" | "task_update" | "break_start" | "break_end" | "checkin" | "chat_message";
    taskId?: number | null;
    createdAt: string;
  },
): number {
  const result = db
    .prepare("INSERT INTO activity_events (type, task_id, created_at) VALUES (?, ?, ?)")
    .run(opts.type, opts.taskId ?? null, opts.createdAt);
  return Number(result.lastInsertRowid);
}

function insertRawDecision(
  db: Database.Database,
  opts: {
    sessionId: number;
    content: string;
    status: "active" | "revised" | "withdrawn";
    createdAt: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO decisions (session_id, content, status, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(opts.sessionId, opts.content, opts.status, opts.createdAt);
  return Number(result.lastInsertRowid);
}

describe("collectDailyReportData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("throws when the evening session has not ended (ended_at is null)", () => {
    const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), null);

    expect(() => collectDailyReportData(db, session)).toThrow();
  });

  describe("日付境界: 23:50開始・翌00:30終了の夕会", () => {
    it("uses the session's start-day local date as the target date, and only collects data within the start day's [00:00:00.000, next local day 00:00:00.000) half-open range", () => {
      const session = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 23, 50),
        iso(2026, 8, 15, 0, 30),
      );
      insertRawTask(db, {
        title: "当日完了タスク",
        status: "done",
        createdAt: iso(2026, 8, 14, 10, 0),
        completedAt: iso(2026, 8, 14, 23, 0),
      });
      // 翌日 00:10 に完了（開始日の範囲外） → 含まれない
      insertRawTask(db, {
        title: "翌日完了タスク",
        status: "done",
        createdAt: iso(2026, 8, 14, 10, 0),
        completedAt: iso(2026, 8, 15, 0, 10),
      });

      const result = collectDailyReportData(db, session);

      expect(result.completedTasks).toEqual(["当日完了タスク"]);
      expect(result.targetDate.getFullYear()).toBe(2026);
      expect(result.targetDate.getMonth()).toBe(7); // 0-indexed → 8月
      expect(result.targetDate.getDate()).toBe(14);
    });
  });

  describe("本日のタスク（完了タスク）", () => {
    it("includes a done task whose completed_at falls on the target day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawTask(db, {
        title: "資料作成",
        status: "done",
        createdAt: iso(2026, 8, 14, 9, 0),
        completedAt: iso(2026, 8, 14, 15, 0),
      });

      const result = collectDailyReportData(db, session);

      expect(result.completedTasks).toEqual(["資料作成"]);
    });

    it("excludes a done task completed on a different day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawTask(db, {
        title: "前日完了タスク",
        status: "done",
        createdAt: iso(2026, 8, 13, 9, 0),
        completedAt: iso(2026, 8, 13, 15, 0),
      });

      const result = collectDailyReportData(db, session);

      expect(result.completedTasks).toEqual([]);
    });

    it.each([["todo"], ["in_progress"], ["dropped"]] as const)(
      "excludes a %s task even if it has a completed_at on the target day",
      (status) => {
        const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
        insertRawTask(db, {
          title: `${status}タスク`,
          status,
          createdAt: iso(2026, 8, 14, 9, 0),
          completedAt: iso(2026, 8, 14, 15, 0),
        });

        const result = collectDailyReportData(db, session);

        expect(result.completedTasks).toEqual([]);
      },
    );

    it("excludes a done task whose completed_at is exactly the next local day's 00:00:00.000 (half-open interval upper bound, ADR 0007 決定3)", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawTask(db, {
        title: "翌日0時ちょうど完了タスク",
        status: "done",
        createdAt: iso(2026, 8, 14, 9, 0),
        completedAt: iso(2026, 8, 15, 0, 0), // 翌ローカル暦日 00:00:00.000 ちょうど
      });

      const result = collectDailyReportData(db, session);

      expect(result.completedTasks).toEqual([]);
    });
  });

  describe("本日のタスク（進行中タスク）", () => {
    it("includes an in_progress task that has a task_start event on the target day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      const taskId = insertRawTask(db, {
        title: "設計レビュー",
        status: "in_progress",
        createdAt: iso(2026, 8, 14, 9, 0),
      });
      insertRawActivityEvent(db, { type: "task_start", taskId, createdAt: iso(2026, 8, 14, 10, 0) });

      const result = collectDailyReportData(db, session);

      expect(result.inProgressTasks).toEqual(["設計レビュー"]);
    });

    it("includes an in_progress task that has only a task_update event on the target day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      const taskId = insertRawTask(db, {
        title: "設計レビュー",
        status: "in_progress",
        createdAt: iso(2026, 8, 14, 9, 0),
      });
      insertRawActivityEvent(db, { type: "task_update", taskId, createdAt: iso(2026, 8, 14, 11, 0) });

      const result = collectDailyReportData(db, session);

      expect(result.inProgressTasks).toEqual(["設計レビュー"]);
    });

    it("excludes an in_progress task with no activity_events on the target day (long-running task with no movement today)", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawTask(db, {
        title: "長期継続タスク",
        status: "in_progress",
        createdAt: iso(2026, 7, 1, 9, 0),
      });

      const result = collectDailyReportData(db, session);

      expect(result.inProgressTasks).toEqual([]);
    });

    it.each([["todo"], ["done"], ["dropped"]] as const)(
      "excludes a %s task even if it has a task_start event on the target day",
      (status) => {
        const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
        const taskId = insertRawTask(db, {
          title: `${status}タスク`,
          status,
          createdAt: iso(2026, 8, 14, 9, 0),
          completedAt: status === "done" ? iso(2026, 8, 14, 12, 0) : null,
        });
        insertRawActivityEvent(db, { type: "task_start", taskId, createdAt: iso(2026, 8, 14, 10, 0) });

        const result = collectDailyReportData(db, session);

        expect(result.inProgressTasks).toEqual([]);
      },
    );

    it("excludes an in_progress task whose only task_start event is exactly the next local day's 00:00:00.000 (half-open interval upper bound, ADR 0007 決定3)", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      const taskId = insertRawTask(db, {
        title: "翌日0時ちょうど着手タスク",
        status: "in_progress",
        createdAt: iso(2026, 8, 14, 9, 0),
      });
      insertRawActivityEvent(db, {
        type: "task_start",
        taskId,
        createdAt: iso(2026, 8, 15, 0, 0), // 翌ローカル暦日 00:00:00.000 ちょうど
      });

      const result = collectDailyReportData(db, session);

      expect(result.inProgressTasks).toEqual([]);
    });
  });

  describe("決定事項", () => {
    it("includes an active decision created on the target day, from any session type", () => {
      const eveningSession = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      const morningSession = insertRawSession(db, "morning", iso(2026, 8, 14, 9, 0), iso(2026, 8, 14, 9, 10));
      insertRawDecision(db, {
        sessionId: morningSession.id,
        content: "朝会での決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 9, 5),
      });

      const result = collectDailyReportData(db, eveningSession);

      expect(result.decisions).toEqual(["朝会での決定"]);
    });

    it("orders decisions by created_at ascending", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawDecision(db, {
        sessionId: session.id,
        content: "後の決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 15, 0),
      });
      insertRawDecision(db, {
        sessionId: session.id,
        content: "先の決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 9, 0),
      });

      const result = collectDailyReportData(db, session);

      expect(result.decisions).toEqual(["先の決定", "後の決定"]);
    });

    it.each([["revised"], ["withdrawn"]] as const)(
      "excludes a %s decision even if created on the target day",
      (status) => {
        const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
        insertRawDecision(db, {
          sessionId: session.id,
          content: `${status}決定`,
          status,
          createdAt: iso(2026, 8, 14, 9, 0),
        });

        const result = collectDailyReportData(db, session);

        expect(result.decisions).toEqual([]);
      },
    );

    it("excludes a decision created on a different day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawDecision(db, {
        sessionId: session.id,
        content: "前日の決定",
        status: "active",
        createdAt: iso(2026, 8, 13, 9, 0),
      });

      const result = collectDailyReportData(db, session);

      expect(result.decisions).toEqual([]);
    });

    it("excludes an active decision created exactly at the next local day's 00:00:00.000 (half-open interval upper bound, ADR 0007 決定3)", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawDecision(db, {
        sessionId: session.id,
        content: "翌日0時ちょうどの決定",
        status: "active",
        createdAt: iso(2026, 8, 15, 0, 0), // 翌ローカル暦日 00:00:00.000 ちょうど
      });

      const result = collectDailyReportData(db, session);

      expect(result.decisions).toEqual([]);
    });
  });

  describe("活動記録との統合", () => {
    it("computes firstTaskStartAt/breakCount/breakTotalMinutes end-to-end, including the day-crossing break case", () => {
      const session = insertRawSession(
        db,
        "evening",
        iso(2026, 8, 14, 23, 50),
        iso(2026, 8, 15, 0, 30),
      );
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 14, 9, 15) });
      insertRawActivityEvent(db, { type: "break_start", createdAt: iso(2026, 8, 14, 23, 55) });
      // 翌日00:05終了・夕会は翌日00:30終了 → 10分として計上される
      insertRawActivityEvent(db, { type: "break_end", createdAt: iso(2026, 8, 15, 0, 5) });

      const result = collectDailyReportData(db, session);

      expect(result.firstTaskStartAt).not.toBeNull();
      expect(result.firstTaskStartAt?.toISOString()).toBe(new Date(iso(2026, 8, 14, 9, 15)).toISOString());
      expect(result.breakCount).toBe(1);
      expect(result.breakTotalMinutes).toBe(10);
    });

    it("reports '着手なし'/'休憩なし' equivalents (null/0) when there are no activity_events on the target day", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));

      const result = collectDailyReportData(db, session);

      expect(result.firstTaskStartAt).toBeNull();
      expect(result.breakCount).toBe(0);
      expect(result.breakTotalMinutes).toBe(0);
    });

    it("produces the same breakCount/breakTotalMinutes whether or not a break_end record exists exactly at the evening session's ended_at (ADR 0007 決定3: half-open interval excludes it from the query, but computeActivityRecord's sessionEndedAt cutoff yields an equivalent result)", () => {
      const startedAt = iso(2026, 8, 14, 23, 50);
      const endedAt = iso(2026, 8, 15, 0, 30);

      // Case A: break_end イベントが存在しない（休憩が未終了のまま夕会が終了した）
      const sessionA = insertRawSession(db, "evening", startedAt, endedAt);
      insertRawActivityEvent(db, { type: "break_start", createdAt: iso(2026, 8, 14, 23, 55) });
      const resultA = collectDailyReportData(db, sessionA);

      // Case B: break_end が夕会 ended_at と完全一致する（半開区間のクエリからは
      // 除外されるが、computeActivityRecord の打ち切りで同じ値になるはず）
      const db2 = openDatabase(":memory:");
      runMigrations(db2);
      const sessionB = insertRawSession(db2, "evening", startedAt, endedAt);
      insertRawActivityEvent(db2, { type: "break_start", createdAt: iso(2026, 8, 14, 23, 55) });
      insertRawActivityEvent(db2, { type: "break_end", createdAt: endedAt });
      const resultB = collectDailyReportData(db2, sessionB);
      db2.close();

      expect(resultB.breakCount).toBe(resultA.breakCount);
      expect(resultB.breakTotalMinutes).toBe(resultA.breakTotalMinutes);
      expect(resultB.breakCount).toBe(1);
      expect(resultB.breakTotalMinutes).toBe(35);
    });

    it("excludes a task_start/break_start event exactly at the next local day's 00:00:00.000 from firstTaskStartAt/breakCount (half-open interval upper bound, ADR 0007 決定3)", () => {
      const session = insertRawSession(db, "evening", iso(2026, 8, 14, 19, 0), iso(2026, 8, 14, 19, 30));
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 15, 0, 0) });
      insertRawActivityEvent(db, { type: "break_start", createdAt: iso(2026, 8, 15, 0, 0) });

      const result = collectDailyReportData(db, session);

      expect(result.firstTaskStartAt).toBeNull();
      expect(result.breakCount).toBe(0);
    });
  });
});
