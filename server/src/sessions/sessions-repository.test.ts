import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  endSession,
  findSessionById,
  insertSession,
  listRecentSessionSummaries,
  listSessions,
  updateSessionSummary,
} from "./sessions-repository.js";

/** Raw-SQL helper for tests that need explicit control over `ended_at` /
 * `started_at` / `summary` (ordering assertions) — distinct from the
 * `insertSession` repository function under test, which manages
 * `started_at` itself and always leaves `ended_at`/`summary` null. */
function insertRawSession(
  db: Database.Database,
  overrides: {
    type: "morning" | "evening" | "adhoc";
    startedAt: string;
    endedAt?: string | null;
    summary?: string | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO sessions (type, started_at, ended_at, summary)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      overrides.type,
      overrides.startedAt,
      overrides.endedAt ?? null,
      overrides.summary ?? null,
    );
  return Number(result.lastInsertRowid);
}

describe("sessions repository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("insertSession", () => {
    it("inserts a session with server-managed started_at and null ended_at/summary", () => {
      const session = insertSession(db, { type: "morning" });

      expect(session).toMatchObject({
        type: "morning",
        ended_at: null,
        summary: null,
      });
      expect(typeof session.id).toBe("number");
      expect(typeof session.started_at).toBe("string");
    });
  });

  describe("findSessionById", () => {
    it("returns the session when it exists", () => {
      const created = insertSession(db, { type: "adhoc" });

      const found = findSessionById(db, created.id);

      expect(found).toEqual(created);
    });

    it("returns undefined when the session does not exist", () => {
      expect(findSessionById(db, 9999)).toBeUndefined();
    });
  });

  describe("listSessions", () => {
    it("returns an empty array when no sessions exist", () => {
      expect(listSessions(db)).toEqual([]);
    });

    it("orders sessions by started_at descending, id descending as tie-breaker", () => {
      const first = insertSession(db, { type: "morning" });
      const second = insertSession(db, { type: "evening" });
      const third = insertSession(db, { type: "adhoc" });

      const result = listSessions(db);

      expect(result.map((s) => s.id)).toEqual([third.id, second.id, first.id]);
    });

    it("filters sessions by type", () => {
      insertSession(db, { type: "morning" });
      const adhoc = insertSession(db, { type: "adhoc" });

      const result = listSessions(db, { type: "adhoc" });

      expect(result.map((s) => s.id)).toEqual([adhoc.id]);
    });
  });

  describe("endSession", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sets ended_at to the current time and returns the updated session", () => {
      const session = insertSession(db, { type: "morning" });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T09:00:00+09:00"));

      const ended = endSession(db, session.id);

      expect(ended).toMatchObject({
        id: session.id,
        ended_at: new Date("2026-07-06T09:00:00+09:00").toISOString(),
      });
    });

    it("returns undefined when the session does not exist", () => {
      expect(endSession(db, 9999)).toBeUndefined();
    });

    it("is idempotent: ending an already-ended session leaves ended_at unchanged", () => {
      const session = insertSession(db, { type: "evening" });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-06T09:00:00+09:00"));
      const firstEnd = endSession(db, session.id);

      vi.setSystemTime(new Date("2026-07-06T10:00:00+09:00"));
      const secondEnd = endSession(db, session.id);

      expect(secondEnd).toEqual(firstEnd);
    });
  });

  describe("updateSessionSummary", () => {
    it("sets the summary and returns the updated session", () => {
      const session = insertSession(db, { type: "morning" });

      const updated = updateSessionSummary(db, session.id, "今日の要約");

      expect(updated).toMatchObject({ id: session.id, summary: "今日の要約" });
    });

    it("returns undefined when the session does not exist", () => {
      expect(updateSessionSummary(db, 9999, "要約")).toBeUndefined();
    });
  });

  describe("listRecentSessionSummaries", () => {
    it("returns an empty array when there are no summarized sessions", () => {
      expect(listRecentSessionSummaries(db, 5)).toEqual([]);
    });

    it("maps type/summary/reportedAt, ordered most-recent (ended_at, falling back to started_at) first", () => {
      insertRawSession(db, {
        type: "morning",
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        summary: "古い朝会の要約",
      });
      insertRawSession(db, {
        type: "evening",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T01:00:00.000Z",
        summary: "新しい夕会の要約",
      });

      const result = listRecentSessionSummaries(db, 5);

      expect(result).toEqual([
        { type: "evening", content: "新しい夕会の要約", reportedAt: "2026-07-05T01:00:00.000Z" },
        { type: "morning", content: "古い朝会の要約", reportedAt: "2026-07-01T01:00:00.000Z" },
      ]);
    });

    it("falls back to started_at for ordering when ended_at is null", () => {
      insertRawSession(db, {
        type: "adhoc",
        startedAt: "2026-07-03T00:00:00.000Z",
        endedAt: null,
        summary: "終了していないが要約はある",
      });

      const result = listRecentSessionSummaries(db, 5);

      expect(result).toEqual([
        {
          type: "adhoc",
          content: "終了していないが要約はある",
          reportedAt: "2026-07-03T00:00:00.000Z",
        },
      ]);
    });

    it("excludes sessions whose summary is null or an empty string", () => {
      insertRawSession(db, {
        type: "morning",
        startedAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
        summary: null,
      });
      insertRawSession(db, {
        type: "evening",
        startedAt: "2026-07-02T00:00:00.000Z",
        endedAt: "2026-07-02T01:00:00.000Z",
        summary: "",
      });
      insertRawSession(db, {
        type: "adhoc",
        startedAt: "2026-07-03T00:00:00.000Z",
        endedAt: "2026-07-03T01:00:00.000Z",
        summary: "有効な要約",
      });

      const result = listRecentSessionSummaries(db, 5);

      expect(result).toEqual([
        { type: "adhoc", content: "有効な要約", reportedAt: "2026-07-03T01:00:00.000Z" },
      ]);
    });

    it("caps the result at the given limit, keeping the most recent ones", () => {
      for (let i = 0; i < 7; i++) {
        insertRawSession(db, {
          type: "adhoc",
          startedAt: `2026-07-0${i + 1}T00:00:00.000Z`,
          endedAt: `2026-07-0${i + 1}T01:00:00.000Z`,
          summary: `要約${i}`,
        });
      }

      const result = listRecentSessionSummaries(db, 5);

      expect(result.map((s) => s.content)).toEqual([
        "要約6",
        "要約5",
        "要約4",
        "要約3",
        "要約2",
      ]);
    });
  });
});
