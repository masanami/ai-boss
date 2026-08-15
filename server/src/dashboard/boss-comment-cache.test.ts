import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { getCachedBossComment, setCachedBossComment } from "./boss-comment-cache.js";

describe("boss-comment-cache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when nothing has been cached yet", () => {
    expect(getCachedBossComment(db, "2026-07-06", "fp-1")).toBeUndefined();
  });

  it("returns the cached comment when both the date key and fingerprint match", () => {
    setCachedBossComment(db, "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(getCachedBossComment(db, "2026-07-06", "fp-1")).toBe("今日も淡々とやれ");
  });

  it("returns undefined (cache miss) when the date key differs but the fingerprint matches", () => {
    setCachedBossComment(db, "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(getCachedBossComment(db, "2026-07-07", "fp-1")).toBeUndefined();
  });

  it("returns undefined (cache miss) when the fingerprint differs but the date key matches (Issue #121)", () => {
    setCachedBossComment(db, "2026-07-06", "fp-1", "今日も淡々とやれ");

    expect(getCachedBossComment(db, "2026-07-06", "fp-2")).toBeUndefined();
  });

  it("overwrites the previous value when set again", () => {
    setCachedBossComment(db, "2026-07-06", "fp-1", "最初のひとこと");
    setCachedBossComment(db, "2026-07-06", "fp-2", "更新後のひとこと");

    expect(getCachedBossComment(db, "2026-07-06", "fp-2")).toBe("更新後のひとこと");
    expect(getCachedBossComment(db, "2026-07-06", "fp-1")).toBeUndefined();
  });
});
