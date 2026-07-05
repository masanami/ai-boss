import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DEFAULT_MODEL } from "../llm/claude-client.js";
import { DEFAULT_PERSONA_SETTINGS } from "./persona-prompt.js";
import { resolveBossSettings } from "./boss-settings.js";

function putSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

describe("resolveBossSettings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("falls back to defaults when no settings are stored", () => {
    const result = resolveBossSettings(db);

    expect(result).toEqual({
      model: DEFAULT_MODEL,
      persona: DEFAULT_PERSONA_SETTINGS,
    });
  });

  it("reads the model from settings when present", () => {
    putSetting(db, "model", "claude-opus-4-8");

    expect(resolveBossSettings(db).model).toBe("claude-opus-4-8");
  });

  it("reads persona fields (name / tone / strictness / custom instructions) from settings", () => {
    putSetting(db, "boss_name", "スミス");
    putSetting(db, "boss_tone_preset", "strict");
    putSetting(db, "boss_strictness", "5");
    putSetting(db, "boss_custom_instructions", "語尾に「〜だ」をつけること");

    const result = resolveBossSettings(db);

    expect(result.persona).toEqual({
      name: "スミス",
      tone: "strict",
      strictness: 5,
      customInstructions: "語尾に「〜だ」をつけること",
    });
  });

  it("falls back to the default tone when the stored value is not a known preset", () => {
    putSetting(db, "boss_tone_preset", "not-a-preset");

    expect(resolveBossSettings(db).persona.tone).toBe(DEFAULT_PERSONA_SETTINGS.tone);
  });

  it.each(["0", "6", "not-a-number"])(
    "falls back to the default strictness when the stored value (%s) is out of range or invalid",
    (value) => {
      putSetting(db, "boss_strictness", value);

      expect(resolveBossSettings(db).persona.strictness).toBe(
        DEFAULT_PERSONA_SETTINGS.strictness,
      );
    },
  );
});
