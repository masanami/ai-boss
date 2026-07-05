import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { getSettingValue } from "./settings-repository.js";

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
