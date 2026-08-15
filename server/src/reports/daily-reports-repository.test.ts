import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import {
  findDailyReportByDate,
  listDailyReports,
  upsertDailyReport,
} from "./daily-reports-repository.js";

describe("daily-reports-repository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  describe("upsertDailyReport", () => {
    it("inserts a new row when no report exists for the date", () => {
      const session = insertSession(db, { type: "evening" });

      const report = upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 日報 2026-08-14（金）",
        evening_session_id: session.id,
      });

      expect(report).toMatchObject({
        date: "2026-08-14",
        content: "# 日報 2026-08-14（金）",
        evening_session_id: session.id,
      });
      expect(typeof report.id).toBe("number");
      expect(typeof report.created_at).toBe("string");
      expect(typeof report.updated_at).toBe("string");
    });

    it("overwrites the same date on re-generation (upsert), keeping created_at but updating updated_at and content", () => {
      // 実時間待機（setTimeout）ではなく fake timers で時刻を進める
      // （CodeRabbit 指摘: 実待機はテストを遅く・不安定にする）。時刻は
      // ローカル日付コンストラクタ由来（CLAUDE.md「テスト方針」）。
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0, 0));

      const session = insertSession(db, { type: "evening" });

      const first = upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 日報（1回目）",
        evening_session_id: session.id,
      });

      // created_at と updated_at の差を検出できるよう、値を1秒進めてから再生成する
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0, 1));

      const secondSession = insertSession(db, { type: "evening" });
      const second = upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 日報（再生成後）",
        evening_session_id: secondSession.id,
      });

      expect(second.id).toBe(first.id);
      expect(second.content).toBe("# 日報（再生成後）");
      expect(second.evening_session_id).toBe(secondSession.id);
      expect(second.created_at).toBe(first.created_at);
      expect(second.updated_at).not.toBe(first.updated_at);
    });

    it("does not create a duplicate row for the same date (UNIQUE upsert)", () => {
      const session = insertSession(db, { type: "evening" });

      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 1回目",
        evening_session_id: session.id,
      });
      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 2回目",
        evening_session_id: session.id,
      });

      const row = db
        .prepare("SELECT COUNT(*) as count FROM daily_reports WHERE date = ?")
        .get("2026-08-14") as { count: number };
      expect(row.count).toBe(1);
    });
  });

  describe("findDailyReportByDate", () => {
    it("returns undefined when no report exists for the date", () => {
      expect(findDailyReportByDate(db, "2026-08-14")).toBeUndefined();
    });

    it("returns the full report row (including content) when it exists", () => {
      const session = insertSession(db, { type: "evening" });
      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 日報 2026-08-14（金）",
        evening_session_id: session.id,
      });

      const found = findDailyReportByDate(db, "2026-08-14");

      expect(found).toMatchObject({
        date: "2026-08-14",
        content: "# 日報 2026-08-14（金）",
        evening_session_id: session.id,
      });
    });
  });

  describe("listDailyReports", () => {
    it("returns an empty array when there are no reports", () => {
      expect(listDailyReports(db)).toEqual([]);
    });

    it("returns only date/created_at/updated_at (no content), ordered by date descending", () => {
      const session = insertSession(db, { type: "evening" });
      upsertDailyReport(db, {
        date: "2026-08-12",
        content: "# 古い日報",
        evening_session_id: session.id,
      });
      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 新しい日報",
        evening_session_id: session.id,
      });

      const list = listDailyReports(db);

      expect(list.map((r) => r.date)).toEqual(["2026-08-14", "2026-08-12"]);
      expect(list[0]).not.toHaveProperty("content");
      expect(list[0]).toHaveProperty("created_at");
      expect(list[0]).toHaveProperty("updated_at");
    });

    it("does not list the same date twice after a re-generation (upsert)", () => {
      const session = insertSession(db, { type: "evening" });
      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 1回目",
        evening_session_id: session.id,
      });
      upsertDailyReport(db, {
        date: "2026-08-14",
        content: "# 再生成後",
        evening_session_id: session.id,
      });

      const list = listDailyReports(db);

      expect(list.filter((r) => r.date === "2026-08-14")).toHaveLength(1);
    });
  });
});
