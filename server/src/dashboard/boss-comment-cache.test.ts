import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { getCachedBossComment, setCachedBossComment } from "./boss-comment-cache.js";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";

describe("boss-comment-cache", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(async () => {
    db.close();
  });

  it("returns undefined when nothing has been cached yet", async () => {
    expect(await getCachedBossComment(portFor(db), "2026-07-06", "fp-1")).toBeUndefined();
  });

  it("returns the cached comment when both the date key and fingerprint match", async () => {
    await setCachedBossComment(portFor(db), "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(await getCachedBossComment(portFor(db), "2026-07-06", "fp-1")).toBe("今日も淡々とやれ");
  });

  it("returns undefined (cache miss) when the date key differs but the fingerprint matches", async () => {
    await setCachedBossComment(portFor(db), "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(await getCachedBossComment(portFor(db), "2026-07-07", "fp-1")).toBeUndefined();
  });

  it("returns undefined (cache miss) when the fingerprint differs but the date key matches (Issue #121)", async () => {
    await setCachedBossComment(portFor(db), "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(await getCachedBossComment(portFor(db), "2026-07-06", "fp-2")).toBeUndefined();
  });

  it("overwrites the previous value when set again", async () => {
    await setCachedBossComment(portFor(db), "2026-07-06", "fp-1", "最初のひとこと");
    await setCachedBossComment(portFor(db), "2026-07-06", "fp-2", "更新後のひとこと");

    expect(await getCachedBossComment(portFor(db), "2026-07-06", "fp-2")).toBe("更新後のひとこと");
    expect(await getCachedBossComment(portFor(db), "2026-07-06", "fp-1")).toBeUndefined();
  });
});

describe("setCachedBossComment on the async DB port (#603・T7)", () => {
  it("AC-12: a write failure in the middle of saving the cache leaves all 3 keys unchanged", async () => {
    const { db, raw, hooks } = await createHookedTestDb();
    await setCachedBossComment(db, "2026-07-06", "fp-1", "前のひとこと");
    let cacheWrites = 0;
    hooks.push({
      matches: (sql) => sql.trimStart().startsWith("INSERT INTO settings"),
      after: () => {
        cacheWrites += 1;
        if (cacheWrites === 2) {
          throw new Error("injected write failure");
        }
      },
    });

    await expect(
      setCachedBossComment(db, "2026-07-07", "fp-2", "新しいひとこと"),
    ).rejects.toThrow("injected write failure");

    expect(cacheWrites).toBe(2);
    expect(await getCachedBossComment(db, "2026-07-06", "fp-1")).toBe("前のひとこと");
    expect(await getCachedBossComment(db, "2026-07-07", "fp-2")).toBeUndefined();
    raw.close();
  });
});
