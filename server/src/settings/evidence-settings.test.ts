import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { setSettingValue } from "./settings-repository.js";
import { resolveEvidenceSettings } from "./evidence-settings.js";

describe("resolveEvidenceSettings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("defaults enforcementEnabled to false when the key is unset (AC-7)", () => {
    expect(resolveEvidenceSettings(db)).toEqual({ enforcementEnabled: false });
  });

  it('reads enforcementEnabled as true when stored as the string "true"', () => {
    setSettingValue(db, "evidence_enforcement_enabled", "true");
    expect(resolveEvidenceSettings(db)).toEqual({ enforcementEnabled: true });
  });

  it('reads enforcementEnabled as false when stored as the string "false"', () => {
    setSettingValue(db, "evidence_enforcement_enabled", "false");
    expect(resolveEvidenceSettings(db)).toEqual({ enforcementEnabled: false });
  });

  it("falls back to false for an unrecognized stored value", () => {
    setSettingValue(db, "evidence_enforcement_enabled", "1");
    expect(resolveEvidenceSettings(db)).toEqual({ enforcementEnabled: false });
  });
});
