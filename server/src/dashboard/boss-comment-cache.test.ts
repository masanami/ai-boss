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
    expect(getCachedBossComment(db, "2026-07-06")).toBeUndefined();
  });

  it("returns the cached comment when the date key matches", () => {
    setCachedBossComment(db, "2026-07-06", "今日も淡々とやれ");

    expect(getCachedBossComment(db, "2026-07-06")).toBe("今日も淡々とやれ");
  });

  it("returns undefined (cache miss) when the date key differs", () => {
    setCachedBossComment(db, "2026-07-06", "今日も淡々とやれ");

    expect(getCachedBossComment(db, "2026-07-07")).toBeUndefined();
  });

  it("overwrites the previous value when set again", () => {
    setCachedBossComment(db, "2026-07-06", "最初のひとこと");
    setCachedBossComment(db, "2026-07-06", "更新後のひとこと");

    expect(getCachedBossComment(db, "2026-07-06")).toBe("更新後のひとこと");
  });
});
