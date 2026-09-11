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

  // 読み出し側ガード（#482, 親要件 #448 決定1・2）: PUT 経由では #480/#481 の
  // バリデータに弾かれて作れない「既に不正な組が保存された DB」を、
  // putSetting でリポジトリ層へ直接書き込んで再現する。
  describe("work_start / work_end correlation guard (AC-7, AC-8, AC-9)", () => {
    it("falls back to the default working-hours pair when work_start equals work_end (AC-7)", () => {
      putSetting(db, "work_start", "09:00");
      putSetting(db, "work_end", "09:00");

      const settings = loadDetectionSettings(db);

      expect(settings.workingHours).toEqual(DEFAULT_DETECTION_SETTINGS.workingHours);
    });

    it("falls back to the default working-hours pair for an overnight range (work_start=22:00, work_end=02:00) (AC-7)", () => {
      putSetting(db, "work_start", "22:00");
      putSetting(db, "work_end", "02:00");

      const settings = loadDetectionSettings(db);

      expect(settings.workingHours).toEqual(DEFAULT_DETECTION_SETTINGS.workingHours);
    });

    it("warns with a message distinguishable from the format-invalid warning when the relationship is invalid (AC-8)", () => {
      putSetting(db, "work_start", "22:00");
      putSetting(db, "work_end", "02:00");

      loadDetectionSettings(db);

      expect(console.warn).toHaveBeenCalledTimes(1);
      const [message] = vi.mocked(console.warn).mock.calls[0] as [string];
      // 既存の書式不正メッセージ（"HH:mm" 形式ではありません）とは異なる
      // 文面であることを確認する。
      expect(message).not.toContain('"HH:mm" 形式ではありません');
      expect(message).toContain("work_start");
      expect(message).toContain("work_end");
    });

    it("does not fall back and returns the stored pair as-is when work_start < work_end (AC-9)", () => {
      putSetting(db, "work_start", "07:59");
      putSetting(db, "work_end", "08:00");

      const settings = loadDetectionSettings(db);

      expect(settings.workingHours).toEqual({ start: "07:59", end: "08:00" });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("falls back to the default pair as a whole, not by patching only one side, for an overnight range", () => {
      putSetting(db, "work_start", "22:00");
      putSetting(db, "work_end", "02:00");

      const settings = loadDetectionSettings(db);

      // 片方だけ既定に差し替えると 22:00-18:00 や 09:00-02:00 のように
      // まだ不正な組が残ってしまう。組として既定へ倒っていることを確認する。
      expect(settings.workingHours.start).toBe(DEFAULT_DETECTION_SETTINGS.workingHours.start);
      expect(settings.workingHours.end).toBe(DEFAULT_DETECTION_SETTINGS.workingHours.end);
    });

    it("runs the relational guard after the format fallback (a format-invalid work_start that falls back to 09:00, combined with a format-valid work_end=05:00, is still an invalid pair)", () => {
      putSetting(db, "work_start", "not-a-time");
      putSetting(db, "work_end", "05:00");

      const settings = loadDetectionSettings(db);

      // work_start が書式不正で既定 09:00 に一旦フォールバックした後、
      // 05:00 との組がなお不正（09:00 >= 05:00）なので、さらに既定の組
      // 09:00-18:00 へ倒る。09:00-05:00 のまま通過してはいけない。
      expect(settings.workingHours).toEqual(DEFAULT_DETECTION_SETTINGS.workingHours);
      expect(console.warn).toHaveBeenCalledTimes(2);
    });
  });
});
