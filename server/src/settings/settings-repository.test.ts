import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/transitional-bridge.js";
import { getSettingValue, setSettingValue } from "./settings-repository.js";

describe("getSettingValue", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(async () => {
    db.close();
  });

  it("returns undefined when the key does not exist", async () => {
    expect(await getSettingValue(portFor(db), "model")).toBeUndefined();
  });

  it("returns the stored value when the key exists", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "model",
      "claude-opus-4-8",
    );

    expect(await getSettingValue(portFor(db), "model")).toBe("claude-opus-4-8");
  });
});

describe("setSettingValue", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(async () => {
    db.close();
  });

  it("inserts a new key that does not exist yet", async () => {
    await setSettingValue(portFor(db), "model", "claude-opus-4-8");

    expect(await getSettingValue(portFor(db), "model")).toBe("claude-opus-4-8");
  });

  it("updates the value when the key already exists (upsert)", async () => {
    await setSettingValue(portFor(db), "model", "claude-opus-4-8");

    await setSettingValue(portFor(db), "model", "claude-sonnet-5");

    expect(await getSettingValue(portFor(db), "model")).toBe("claude-sonnet-5");
  });

  it("clears the effective value when set to null (getSettingValue then returns undefined)", async () => {
    await setSettingValue(portFor(db), "boss_custom_instructions", "既存の指示");

    await setSettingValue(portFor(db), "boss_custom_instructions", null);

    expect(await getSettingValue(portFor(db), "boss_custom_instructions")).toBeUndefined();
  });
});
