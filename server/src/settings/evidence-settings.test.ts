import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/transitional-bridge.js";
import { setSettingValue } from "./settings-repository.js";
import { resolveEvidenceSettings } from "./evidence-settings.js";

describe("resolveEvidenceSettings", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(async () => {
    db.close();
  });

  it("defaults enforcementEnabled to false when the key is unset (AC-7)", async () => {
    expect(await resolveEvidenceSettings(portFor(db))).toEqual({ enforcementEnabled: false });
  });

  it('reads enforcementEnabled as true when stored as the string "true"', async () => {
    await setSettingValue(portFor(db), "evidence_enforcement_enabled", "true");
    expect(await resolveEvidenceSettings(portFor(db))).toEqual({ enforcementEnabled: true });
  });

  it('reads enforcementEnabled as false when stored as the string "false"', async () => {
    await setSettingValue(portFor(db), "evidence_enforcement_enabled", "false");
    expect(await resolveEvidenceSettings(portFor(db))).toEqual({ enforcementEnabled: false });
  });

  it("falls back to false for an unrecognized stored value", async () => {
    await setSettingValue(portFor(db), "evidence_enforcement_enabled", "1");
    expect(await resolveEvidenceSettings(portFor(db))).toEqual({ enforcementEnabled: false });
  });
});
