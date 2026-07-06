import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { getSettingValue, setSettingValue } from "./settings-repository.js";

describe("getSettingValue", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when the key does not exist", () => {
    expect(getSettingValue(db, "model")).toBeUndefined();
  });

  it("returns the stored value when the key exists", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "model",
      "claude-opus-4-8",
    );

    expect(getSettingValue(db, "model")).toBe("claude-opus-4-8");
  });
});

describe("setSettingValue", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a new key that does not exist yet", () => {
    setSettingValue(db, "model", "claude-opus-4-8");

    expect(getSettingValue(db, "model")).toBe("claude-opus-4-8");
  });

  it("updates the value when the key already exists (upsert)", () => {
    setSettingValue(db, "model", "claude-opus-4-8");

    setSettingValue(db, "model", "claude-sonnet-5");

    expect(getSettingValue(db, "model")).toBe("claude-sonnet-5");
  });

  it("clears the effective value when set to null (getSettingValue then returns undefined)", () => {
    setSettingValue(db, "boss_custom_instructions", "既存の指示");

    setSettingValue(db, "boss_custom_instructions", null);

    expect(getSettingValue(db, "boss_custom_instructions")).toBeUndefined();
  });
});
