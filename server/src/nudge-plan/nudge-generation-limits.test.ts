import { beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../db/test-support/create-test-db.js";
import type { DbPort } from "../db/db-port.js";
import { tryReserveGenerationAttempt, type GenerationKind } from "./nudge-generation-limits.js";

function insertAttempts(raw: Database.Database, kind: GenerationKind, at: Date, count: number): void {
  const stmt = raw.prepare("INSERT INTO nudge_generation_attempts (kind, attempted_at) VALUES (?, ?)");
  for (let i = 0; i < count; i++) stmt.run(kind, at.toISOString());
}

function attemptCount(raw: Database.Database, kind: GenerationKind): number {
  return (
    raw.prepare("SELECT COUNT(*) AS c FROM nudge_generation_attempts WHERE kind = ?").get(kind) as { c: number }
  ).c;
}

describe("tryReserveGenerationAttempt", () => {
  let db: DbPort;
  let raw: Database.Database;
  const now = new Date(2026, 8, 14, 15, 0);

  beforeEach(async () => {
    ({ db, raw } = await createTestDb());
  });

  describe("individual (B): 12 per hour", () => {
    it("allows the 12th attempt within the last 60 minutes", async () => {
      insertAttempts(raw, "individual", new Date(now.getTime() - 30 * 60_000), 11);
      await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(true);
      expect(attemptCount(raw, "individual")).toBe(12);
    });

    it("refuses the 13th attempt within the last 60 minutes and does not record it", async () => {
      insertAttempts(raw, "individual", new Date(now.getTime() - 30 * 60_000), 12);
      await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(false);
      expect(attemptCount(raw, "individual")).toBe(12);
    });

    it("does not count attempts older than 60 minutes toward the hourly window", async () => {
      insertAttempts(raw, "individual", new Date(now.getTime() - 61 * 60_000), 12);
      await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(true);
    });
  });

  describe("individual (B): 60 per local calendar day", () => {
    it("allows the 60th attempt of the day", async () => {
      insertAttempts(raw, "individual", new Date(2026, 8, 14, 9, 0), 59);
      await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(true);
    });

    it("refuses the 61st attempt of the day", async () => {
      insertAttempts(raw, "individual", new Date(2026, 8, 14, 9, 0), 60);
      await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(false);
    });

    it("opens the daily window at local midnight", async () => {
      insertAttempts(raw, "individual", new Date(2026, 8, 13, 20, 0), 60);
      const justAfterMidnight = new Date(2026, 8, 14, 0, 0);
      await expect(tryReserveGenerationAttempt(db, "individual", justAfterMidnight)).resolves.toBe(true);
    });

    it("does not reopen the hourly window at local midnight", async () => {
      insertAttempts(raw, "individual", new Date(2026, 8, 13, 23, 30), 12);
      await expect(tryReserveGenerationAttempt(db, "individual", new Date(2026, 8, 14, 0, 5))).resolves.toBe(false);
    });

    it("still refuses just before local midnight", async () => {
      insertAttempts(raw, "individual", new Date(2026, 8, 13, 20, 0), 60);
      const justBeforeMidnight = new Date(2026, 8, 13, 23, 59, 59, 999);
      await expect(tryReserveGenerationAttempt(db, "individual", justBeforeMidnight)).resolves.toBe(false);
    });
  });

  describe("message set (C): 3 per local calendar day", () => {
    it("allows the 3rd attempt of the day", async () => {
      insertAttempts(raw, "message_set", new Date(2026, 8, 14, 9, 0), 2);
      await expect(tryReserveGenerationAttempt(db, "message_set", now)).resolves.toBe(true);
    });

    it("refuses the 4th attempt of the day", async () => {
      insertAttempts(raw, "message_set", new Date(2026, 8, 14, 9, 0), 3);
      await expect(tryReserveGenerationAttempt(db, "message_set", now)).resolves.toBe(false);
    });

    it("has no hourly window (3 attempts within a minute are allowed)", async () => {
      insertAttempts(raw, "message_set", now, 2);
      await expect(tryReserveGenerationAttempt(db, "message_set", now)).resolves.toBe(true);
    });

    it("counts the kinds separately", async () => {
      insertAttempts(raw, "individual", now, 12);
      await expect(tryReserveGenerationAttempt(db, "message_set", now)).resolves.toBe(true);
    });
  });

  it("keeps counting attempts recorded in the future when the clock has been turned back", async () => {
    insertAttempts(raw, "individual", new Date(now.getTime() + 2 * 60 * 60_000), 12);
    await expect(tryReserveGenerationAttempt(db, "individual", now)).resolves.toBe(false);
    insertAttempts(raw, "message_set", new Date(2026, 8, 15, 9, 0), 3);
    await expect(tryReserveGenerationAttempt(db, "message_set", now)).resolves.toBe(false);
  });

  it("grants only one of two concurrent requests when one attempt remains", async () => {
    insertAttempts(raw, "individual", new Date(now.getTime() - 10 * 60_000), 11);
    const results = await Promise.all([
      tryReserveGenerationAttempt(db, "individual", now),
      tryReserveGenerationAttempt(db, "individual", now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(attemptCount(raw, "individual")).toBe(12);
  });
});
