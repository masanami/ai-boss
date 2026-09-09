import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { setSettingValue } from "./settings-repository.js";
import { resolveMorningMentoringRequired } from "./mentoring-settings.js";

// 朝会メンタリング必須設定（#406）。判断7: 未設定・不正値は「オン」
// （evidence_enforcement_enabled とは既定値の向きが逆であることに注意）。
describe("resolveMorningMentoringRequired", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("defaults to true when the key is unset (AC-32)", () => {
    expect(resolveMorningMentoringRequired(db)).toBe(true);
  });

  it('reads true when stored as the string "true"', () => {
    setSettingValue(db, "morning_mentoring_required", "true");
    expect(resolveMorningMentoringRequired(db)).toBe(true);
  });

  it('reads false when stored as the string "false" (AC-33 read-back)', () => {
    setSettingValue(db, "morning_mentoring_required", "false");
    expect(resolveMorningMentoringRequired(db)).toBe(false);
  });

  it('falls back to true (on) for an unrecognized stored value (AC-37)', () => {
    setSettingValue(db, "morning_mentoring_required", "yes");
    expect(resolveMorningMentoringRequired(db)).toBe(true);
  });
});
