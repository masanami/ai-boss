import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DEFAULT_DETECTION_SETTINGS } from "../detection/detection-types.js";
import { loadDetectionSettings } from "./detection-settings.js";

function putSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

describe("loadDetectionSettings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("returns DEFAULT_DETECTION_SETTINGS when no settings rows exist (Issue #38 explicit assumptions)", () => {
    expect(loadDetectionSettings(db)).toEqual(DEFAULT_DETECTION_SETTINGS);
  });

  it("overrides working hours, meeting times, fallback minutes, and escalation intervals from settings", () => {
    putSetting(db, "work_start", "08:00");
    putSetting(db, "work_end", "20:00");
    putSetting(db, "morning_meeting_time", "08:30");
    putSetting(db, "evening_meeting_time", "19:00");
    putSetting(db, "detection_unstarted_fallback_minutes", "90");
    putSetting(db, "detection_break_fallback_minutes", "20");
    putSetting(db, "detection_silence_fallback_minutes", "30");
    putSetting(db, "escalation_l2_after_minutes", "25");
    putSetting(db, "escalation_l3_after_minutes", "5");
    putSetting(db, "escalation_repeat_minutes", "8");

    const settings = loadDetectionSettings(db);

    expect(settings.workingHours).toEqual({ start: "08:00", end: "20:00" });
    expect(settings.morningMeetingTime).toBe("08:30");
    expect(settings.eveningMeetingTime).toBe("19:00");
    expect(settings.unstarted.fallback).toBe(90);
    expect(settings.breakFallbackMinutes).toBe(20);
    expect(settings.silence.fallback).toBe(30);
    expect(settings.escalation).toEqual({
      level1ToLevel2Minutes: 25,
      level2ToLevel3Minutes: 5,
      level3RepeatMinutes: 8,
    });
  });

  it("does not override scale/min/max/avoidanceWindowMinutes (Issue #38 lists no settings keys for them)", () => {
    putSetting(db, "detection_unstarted_fallback_minutes", "90");

    const settings = loadDetectionSettings(db);

    expect(settings.unstarted.scale).toBe(DEFAULT_DETECTION_SETTINGS.unstarted.scale);
    expect(settings.unstarted.min).toBe(DEFAULT_DETECTION_SETTINGS.unstarted.min);
    expect(settings.unstarted.max).toBe(DEFAULT_DETECTION_SETTINGS.unstarted.max);
    expect(settings.avoidanceWindowMinutes).toBe(
      DEFAULT_DETECTION_SETTINGS.avoidanceWindowMinutes,
    );
  });

  it("falls back to the default and warns when a time setting has an invalid format", () => {
    putSetting(db, "work_start", "not-a-time");

    const settings = loadDetectionSettings(db);

    expect(settings.workingHours.start).toBe(DEFAULT_DETECTION_SETTINGS.workingHours.start);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to the default and warns when a minutes setting is not a positive integer", () => {
    putSetting(db, "detection_silence_fallback_minutes", "not-a-number");

    const settings = loadDetectionSettings(db);

    expect(settings.silence.fallback).toBe(DEFAULT_DETECTION_SETTINGS.silence.fallback);
    expect(console.warn).toHaveBeenCalled();
  });
});
