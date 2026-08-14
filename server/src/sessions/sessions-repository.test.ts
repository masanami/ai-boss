import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  createSession,
  endSession,
  findSessionById,
  insertSession,
  listSessions,
} from "./sessions-repository.js";

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

  describe("createSession", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("creates an evening session when no evening session exists today", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 18, 0));

      const result = createSession(db, { type: "evening" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.session).toMatchObject({ type: "evening", ended_at: null });
      }
      expect(listSessions(db, { type: "evening" })).toHaveLength(1);
    });

    it("rejects a second evening session on the same local day without inserting a row", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
      const first = createSession(db, { type: "evening" });
      expect(first.ok).toBe(true);

      vi.setSystemTime(new Date(2026, 7, 14, 20, 0));
      const second = createSession(db, { type: "evening" });

      expect(second).toEqual({
        ok: false,
        code: "evening_session_already_exists",
      });
      expect(listSessions(db, { type: "evening" })).toHaveLength(1);
    });

    it("allows today's evening session when only a previous day's evening session exists (date boundary)", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 13, 23, 50));
      const previousDay = createSession(db, { type: "evening" });
      expect(previousDay.ok).toBe(true);
      if (!previousDay.ok) {
        throw new Error("expected previous day's session to be created");
      }

      vi.setSystemTime(new Date(2026, 7, 14, 0, 30));
      endSession(db, previousDay.session.id);

      vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
      const today = createSession(db, { type: "evening" });

      expect(today.ok).toBe(true);
      expect(listSessions(db, { type: "evening" })).toHaveLength(2);
    });

    it("rejects a second evening session even when the existing one is already ended", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 18, 0));
      const first = createSession(db, { type: "evening" });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error("expected first session to be created");
      }
      vi.setSystemTime(new Date(2026, 7, 14, 19, 0));
      endSession(db, first.session.id);

      vi.setSystemTime(new Date(2026, 7, 14, 20, 0));
      const second = createSession(db, { type: "evening" });

      expect(second).toEqual({
        ok: false,
        code: "evening_session_already_exists",
      });
      expect(listSessions(db, { type: "evening" })).toHaveLength(1);
    });

    it("does not limit morning or adhoc sessions on the same local day", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 14, 9, 0));

      const firstMorning = createSession(db, { type: "morning" });
      const secondMorning = createSession(db, { type: "morning" });
      const firstAdhoc = createSession(db, { type: "adhoc" });
      const secondAdhoc = createSession(db, { type: "adhoc" });

      expect(firstMorning.ok).toBe(true);
      expect(secondMorning.ok).toBe(true);
      expect(firstAdhoc.ok).toBe(true);
      expect(secondAdhoc.ok).toBe(true);
      expect(listSessions(db, { type: "morning" })).toHaveLength(2);
      expect(listSessions(db, { type: "adhoc" })).toHaveLength(2);
    });
  });
});
