import { describe, expect, it } from "vitest";
import { selectRestoreSessions } from "./select-restore-session";
import type { ChatSession } from "./chat";

// Local-time anchor, matching the TZ-independent convention used by
// use-chat.test.ts (isSameLocalDay compares local dates).
const NOW = new Date(2026, 6, 5, 12, 0, 0); // 2026-07-05 12:00 local
const localIso = (day: number, hour: number) =>
  new Date(2026, 6, day, hour, 0, 0).toISOString();

function makeSession(overrides: Partial<ChatSession> & { id: number }): ChatSession {
  return {
    type: "adhoc",
    started_at: localIso(5, 9),
    ended_at: null,
    summary: null,
    ...overrides,
  };
}

describe("selectRestoreSessions", () => {
  it("returns null for both when there are no sessions", () => {
    expect(selectRestoreSessions([], NOW)).toEqual({ active: null, adhoc: null });
  });

  it("picks today's open morning session as active, alongside today's adhoc session", () => {
    const morning = makeSession({ id: 1, type: "morning", started_at: localIso(5, 8) });
    const adhoc = makeSession({ id: 2, type: "adhoc", started_at: localIso(5, 9) });

    expect(selectRestoreSessions([adhoc, morning], NOW)).toEqual({
      active: morning,
      adhoc,
    });
  });

  it("picks today's open evening session as active", () => {
    const evening = makeSession({ id: 3, type: "evening", started_at: localIso(5, 18) });

    expect(selectRestoreSessions([evening], NOW)).toEqual({
      active: evening,
      adhoc: null,
    });
  });

  it("when both morning and evening are open today, picks the more recently started one regardless of input order", () => {
    const morning = makeSession({ id: 1, type: "morning", started_at: localIso(5, 8) });
    const evening = makeSession({ id: 2, type: "evening", started_at: localIso(5, 18) });

    expect(selectRestoreSessions([morning, evening], NOW).active).toEqual(evening);
    expect(selectRestoreSessions([evening, morning], NOW).active).toEqual(evening);
  });

  it("breaks a started_at tie between two open meetings by the larger id", () => {
    const tiedStart = localIso(5, 8);
    const older = makeSession({ id: 5, type: "morning", started_at: tiedStart });
    const newer = makeSession({ id: 6, type: "evening", started_at: tiedStart });

    expect(selectRestoreSessions([older, newer], NOW).active).toEqual(newer);
  });

  it("falls back to today's adhoc session when today's morning session is already ended", () => {
    const endedMorning = makeSession({
      id: 1,
      type: "morning",
      started_at: localIso(5, 8),
      ended_at: localIso(5, 9),
    });
    const adhoc = makeSession({ id: 2, type: "adhoc", started_at: localIso(5, 10) });

    expect(selectRestoreSessions([endedMorning, adhoc], NOW)).toEqual({
      active: adhoc,
      adhoc,
    });
  });

  it("ignores an open morning session from a previous day", () => {
    const yesterdayMorning = makeSession({
      id: 1,
      type: "morning",
      started_at: localIso(4, 8),
    });

    expect(selectRestoreSessions([yesterdayMorning], NOW)).toEqual({
      active: null,
      adhoc: null,
    });
  });

  it("ignores an adhoc session from a previous day", () => {
    const yesterdayAdhoc = makeSession({ id: 1, started_at: localIso(4, 9) });

    expect(selectRestoreSessions([yesterdayAdhoc], NOW)).toEqual({
      active: null,
      adhoc: null,
    });
  });

  it("returns null for both when today's only adhoc session is already ended", () => {
    const endedAdhoc = makeSession({
      id: 1,
      started_at: localIso(5, 9),
      ended_at: localIso(5, 10),
    });

    expect(selectRestoreSessions([endedAdhoc], NOW)).toEqual({
      active: null,
      adhoc: null,
    });
  });

  it("still restores today's unfinished adhoc session when an ended one started more recently", () => {
    const openAdhoc = makeSession({ id: 1, started_at: localIso(5, 9) });
    const endedAdhoc = makeSession({
      id: 2,
      started_at: localIso(5, 10),
      ended_at: localIso(5, 11),
    });

    expect(selectRestoreSessions([openAdhoc, endedAdhoc], NOW)).toEqual({
      active: openAdhoc,
      adhoc: openAdhoc,
    });
  });

  it("does not use an ended adhoc session as the return point when an open meeting is active (Issue #206 decision A)", () => {
    const morning = makeSession({ id: 1, type: "morning", started_at: localIso(5, 8) });
    const endedAdhoc = makeSession({
      id: 2,
      started_at: localIso(5, 7),
      ended_at: localIso(5, 7),
    });

    expect(selectRestoreSessions([morning, endedAdhoc], NOW)).toEqual({
      active: morning,
      adhoc: null,
    });
  });
});
