import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { collectWorkLogData } from "./collect-work-log-data.js";

// ローカル日付基準・TZ非依存: new Date(y, m, d, h, mi) から toISOString() で
// DB 用の値を作る（CLAUDE.md「テスト方針」）。
function iso(y: number, m: number, d: number, h: number, mi: number, s = 0, ms = 0): string {
  return new Date(y, m - 1, d, h, mi, s, ms).toISOString();
}

function insertRawTask(
  db: Database.Database,
  opts: { title: string; createdAt: string },
): number {
  const result = db
    .prepare(
      `INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, 'todo', ?, ?)`,
    )
    .run(opts.title, opts.createdAt, opts.createdAt);
  return Number(result.lastInsertRowid);
}

function insertRawSession(db: Database.Database, createdAt: string): number {
  const result = db
    .prepare("INSERT INTO sessions (type, started_at, ended_at) VALUES ('evening', ?, ?)")
    .run(createdAt, createdAt);
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

function insertRawActivityEvent(
  db: Database.Database,
  opts: {
    type:
      | "task_start"
      | "task_update"
      | "break_start"
      | "break_end"
      | "checkin"
      | "task_pause"
      | "chat_message";
    taskId?: number | null;
    note?: string | null;
    expectedMinutes?: number | null;
    createdAt: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO activity_events (type, task_id, note, expected_minutes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.type,
      opts.taskId ?? null,
      opts.note ?? null,
      opts.expectedMinutes ?? null,
      opts.createdAt,
    );
  return Number(result.lastInsertRowid);
}

describe("collectWorkLogData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty decisions/activityEvents when nothing exists on the target day", () => {
    const result = collectWorkLogData(db, new Date(2026, 7, 14));

    expect(result.decisions).toEqual([]);
    expect(result.activityEvents).toEqual([]);
    expect(result.targetDate).toEqual(new Date(2026, 7, 14));
  });

  it("does not require an evening session (no prerequisite — generation is always available)", () => {
    const sessionId = insertRawSession(db, iso(2026, 8, 14, 9, 0));
    insertRawDecision(db, {
      sessionId,
      content: "夕会なしでも収集される決定",
      status: "active",
      createdAt: iso(2026, 8, 14, 10, 0),
    });

    const result = collectWorkLogData(db, new Date(2026, 7, 14));

    expect(result.decisions).toHaveLength(1);
  });

  describe("決定ログ", () => {
    it.each([["active"], ["revised"], ["withdrawn"]] as const)(
      "collects a %s decision on the target day",
      (status) => {
        const sessionId = insertRawSession(db, iso(2026, 8, 14, 9, 0));
        insertRawDecision(db, {
          sessionId,
          content: `${status}の決定`,
          status,
          createdAt: iso(2026, 8, 14, 10, 0),
        });

        const result = collectWorkLogData(db, new Date(2026, 7, 14));

        expect(result.decisions).toEqual([
          { id: expect.any(Number), status, content: `${status}の決定`, createdAt: new Date(iso(2026, 8, 14, 10, 0)) },
        ]);
      },
    );

    it("orders decisions by created_at ascending, then id ascending", () => {
      const sessionId = insertRawSession(db, iso(2026, 8, 14, 9, 0));
      insertRawDecision(db, {
        sessionId,
        content: "後の決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 15, 0),
      });
      insertRawDecision(db, {
        sessionId,
        content: "先の決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 9, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.decisions.map((d) => d.content)).toEqual(["先の決定", "後の決定"]);
    });

    it("excludes a decision created on a different day", () => {
      const sessionId = insertRawSession(db, iso(2026, 8, 13, 9, 0));
      insertRawDecision(db, {
        sessionId,
        content: "前日の決定",
        status: "active",
        createdAt: iso(2026, 8, 13, 9, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.decisions).toEqual([]);
    });

    // 本番の書き込み（decisions-repository.ts / activity-events-repository.ts）は
    // いずれも `new Date().toISOString()` で常に固定ミリ秒精度・`Z` 付きの
    // created_at を生成するため、実データでは旧実装（閉区間 `<= 23:59:59.999`）
    // でもこの境界は同じ結果になる。つまりこのテストは回帰再現ではなく、
    // 半開区間の契約を明文化するもの（ADR 0007 決定3）。
    it("excludes a decision created at exactly the next local day's 00:00:00.000 (half-open upper bound)", () => {
      const sessionId = insertRawSession(db, iso(2026, 8, 15, 0, 0));
      insertRawDecision(db, {
        sessionId,
        content: "翌日0時ちょうどの決定",
        status: "active",
        createdAt: iso(2026, 8, 15, 0, 0, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.decisions).toEqual([]);
    });

    it("includes a decision created at exactly the target day's own 00:00:00.000 (half-open lower bound, inclusive)", () => {
      const sessionId = insertRawSession(db, iso(2026, 8, 14, 0, 0));
      insertRawDecision(db, {
        sessionId,
        content: "当日0時ちょうどの決定",
        status: "active",
        createdAt: iso(2026, 8, 14, 0, 0, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.decisions).toHaveLength(1);
    });
  });

  describe("activity_events", () => {
    it("excludes chat_message events", () => {
      insertRawActivityEvent(db, { type: "chat_message", createdAt: iso(2026, 8, 14, 10, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents).toEqual([]);
    });

    it.each([
      ["task_start"],
      ["task_update"],
      ["break_start"],
      ["break_end"],
      ["checkin"],
      ["task_pause"],
    ] as const)("collects a %s event on the target day", (type) => {
      insertRawActivityEvent(db, { type, createdAt: iso(2026, 8, 14, 10, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents).toHaveLength(1);
      expect(result.activityEvents[0].type).toBe(type);
    });

    it("collects a task_pause event and resolves its task title (G-179-13)", () => {
      const taskId = insertRawTask(db, { title: "資料作成", createdAt: iso(2026, 8, 14, 9, 0) });
      insertRawActivityEvent(db, {
        type: "task_pause",
        taskId,
        createdAt: iso(2026, 8, 14, 11, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents).toEqual([
        expect.objectContaining({ type: "task_pause", taskTitle: "資料作成" }),
      ]);
    });

    it("resolves the task title from task_id", () => {
      const taskId = insertRawTask(db, { title: "資料作成", createdAt: iso(2026, 8, 14, 9, 0) });
      insertRawActivityEvent(db, { type: "task_start", taskId, createdAt: iso(2026, 8, 14, 10, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents[0].taskTitle).toBe("資料作成");
    });

    it("resolves a null taskTitle when task_id is null", () => {
      insertRawActivityEvent(db, { type: "task_start", taskId: null, createdAt: iso(2026, 8, 14, 10, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents[0].taskTitle).toBeNull();
    });

    it("resolves a null taskTitle when the referenced task does not exist", () => {
      // 現行の tasks-repository にタスク削除 API は無く FK 制約
      // (server/src/db/connection.ts) が通常経路での孤立を防ぐが、将来の
      // 削除機能や手動データ操作に備え、収集段が防御的に null 解決すること
      // を確認する（一時的に FK 制約を外して孤立行を作る）。
      const taskId = insertRawTask(db, { title: "削除予定タスク", createdAt: iso(2026, 8, 14, 9, 0) });
      insertRawActivityEvent(db, { type: "task_start", taskId, createdAt: iso(2026, 8, 14, 10, 0) });
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      db.pragma("foreign_keys = ON");

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents[0].taskTitle).toBeNull();
    });

    it("collects note and expected_minutes", () => {
      insertRawActivityEvent(db, {
        type: "break_start",
        note: "長めに取る",
        expectedMinutes: 15,
        createdAt: iso(2026, 8, 14, 10, 0),
      });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents[0]).toMatchObject({ note: "長めに取る", expectedMinutes: 15 });
    });

    it("orders events by created_at ascending, then id ascending", () => {
      insertRawActivityEvent(db, { type: "checkin", createdAt: iso(2026, 8, 14, 15, 0) });
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 14, 9, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents.map((e) => e.type)).toEqual(["task_start", "checkin"]);
    });

    it("excludes events on a different day (day-boundary, no evening-session extension)", () => {
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 13, 23, 59) });
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 15, 0, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents).toEqual([]);
    });

    it("excludes an event created at exactly the next local day's 00:00:00.000 (half-open upper bound)", () => {
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 14, 23, 59, 59, 999) });
      insertRawActivityEvent(db, { type: "checkin", createdAt: iso(2026, 8, 15, 0, 0, 0, 0) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents.map((e) => e.type)).toEqual(["task_start"]);
    });

    it("includes events at the exact day boundaries (00:00:00.000 and 23:59:59.999)", () => {
      insertRawActivityEvent(db, { type: "task_start", createdAt: iso(2026, 8, 14, 0, 0, 0, 0) });
      insertRawActivityEvent(db, { type: "checkin", createdAt: iso(2026, 8, 14, 23, 59, 59, 999) });

      const result = collectWorkLogData(db, new Date(2026, 7, 14));

      expect(result.activityEvents).toHaveLength(2);
    });
  });
});
