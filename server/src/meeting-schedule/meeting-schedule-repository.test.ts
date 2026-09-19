import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  findOverridesByDate,
  upsertOverride,
  deleteOverride,
} from "./meeting-schedule-repository.js";

describe("meeting-schedule-repository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("findOverridesByDate", () => {
    it("returns an empty object when there are no overrides for the date", () => {
      expect(findOverridesByDate(db, "2026-09-20")).toEqual({});
    });

    it("returns only the overridden types, keyed by meeting_type", () => {
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({ evening: "21:00" });
    });

    it("does not return overrides stored for a different date", () => {
      upsertOverride(db, "2026-09-19", "evening", "21:00");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({});
    });

    it("returns both types when both are overridden", () => {
      upsertOverride(db, "2026-09-20", "morning", "07:00");
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({
        morning: "07:00",
        evening: "21:00",
      });
    });
  });

  describe("upsertOverride", () => {
    it("inserts a new row with created_at and updated_at populated", () => {
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      const row = db
        .prepare(
          "SELECT meeting_time, created_at, updated_at FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get("2026-09-20", "evening") as {
        meeting_time: string;
        created_at: string;
        updated_at: string;
      };
      expect(row.meeting_time).toBe("21:00");
      expect(row.created_at).not.toBe("");
      expect(row.updated_at).not.toBe("");
    });

    it("updates the existing row (not insert a second one) when called again for the same date and type", () => {
      upsertOverride(db, "2026-09-20", "evening", "21:00");
      upsertOverride(db, "2026-09-20", "evening", "22:00");

      const rows = db
        .prepare(
          "SELECT meeting_time FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .all("2026-09-20", "evening") as { meeting_time: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].meeting_time).toBe("22:00");
    });

    it("keeps the original created_at but refreshes updated_at on update", () => {
      // 同一ミリ秒での ISO 文字列衝突を避けるため、2回の upsert 呼び出しの
      // 間で `Date.now()` を進める（固定時刻はローカル日付由来、ADR 0007 決定5）。
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 20, 9, 0, 0, 0));
      upsertOverride(db, "2026-09-20", "evening", "21:00");
      const before = db
        .prepare(
          "SELECT created_at, updated_at FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get("2026-09-20", "evening") as { created_at: string; updated_at: string };

      vi.setSystemTime(new Date(2026, 8, 20, 9, 5, 0, 0));
      upsertOverride(db, "2026-09-20", "evening", "22:00");
      vi.useRealTimers();

      const after = db
        .prepare(
          "SELECT created_at, updated_at FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get("2026-09-20", "evening") as { created_at: string; updated_at: string };
      expect(after.created_at).toBe(before.created_at);
      expect(after.updated_at).not.toBe(before.updated_at);
    });

    it("does not affect the other meeting_type on the same date", () => {
      upsertOverride(db, "2026-09-20", "morning", "07:00");
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({
        morning: "07:00",
        evening: "21:00",
      });
    });
  });

  describe("deleteOverride", () => {
    it("removes the row for the given date and type", () => {
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      deleteOverride(db, "2026-09-20", "evening");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({});
    });

    it("does not affect the other meeting_type on the same date", () => {
      upsertOverride(db, "2026-09-20", "morning", "07:00");
      upsertOverride(db, "2026-09-20", "evening", "21:00");

      deleteOverride(db, "2026-09-20", "evening");

      expect(findOverridesByDate(db, "2026-09-20")).toEqual({ morning: "07:00" });
    });

    it("is a no-op when there is no row to delete", () => {
      expect(() => deleteOverride(db, "2026-09-20", "evening")).not.toThrow();
      expect(findOverridesByDate(db, "2026-09-20")).toEqual({});
    });
  });
});
