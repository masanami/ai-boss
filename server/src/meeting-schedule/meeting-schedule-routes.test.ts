import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { setSettingValue } from "../settings/settings-repository.js";
import { upsertOverride } from "./meeting-schedule-repository.js";

interface MeetingSlot {
  time: string;
  defaultTime: string;
  overridden: boolean;
  latestAllowedTime: string;
}

interface MeetingScheduleBody {
  date: string;
  morning: MeetingSlot;
  evening: MeetingSlot;
}

interface ErrorBody {
  error: string;
  code?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// 「当日」を固定するため、ローカル日付由来（`new Date(y, m, d, h, mi)`）で
// システム時刻を固定する（ADR 0007 決定5: UTC 文字列リテラルで固定しない）。
const TODAY = new Date(2026, 8, 20, 10, 0, 0, 0); // 2026-09-20 10:00 ローカル
const TODAY_KEY = "2026-09-20";
const YESTERDAY_KEY = "2026-09-19";

describe("meeting-schedule routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe("GET /api/meeting-schedule/:date", () => {
    it("returns the default time for a type with no override (AC-22)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      expect(res.status).toBe(200);
      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.morning.time).toBe("09:00");
      expect(body.evening.time).toBe("18:00");
    });

    it("returns the override time for a type with an override (AC-23)", async () => {
      upsertOverride(db, TODAY_KEY, "evening", "21:00");
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.time).toBe("21:00");
    });

    it("returns the constant setting time as defaultTime regardless of override presence (AC-24)", async () => {
      upsertOverride(db, TODAY_KEY, "evening", "21:00");
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.defaultTime).toBe("18:00");
      expect(body.morning.defaultTime).toBe("09:00");
    });

    it("returns overridden: true for a type whose effective time differs from the default (AC-25)", async () => {
      upsertOverride(db, TODAY_KEY, "evening", "21:00");
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.overridden).toBe(true);
    });

    it("returns overridden: false for a type with no override row (AC-26)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.morning.overridden).toBe(false);
    });

    it("returns overridden: false when an override row exists but its stored value equals the default (AC-27, 行の存在ではなく値の比較であることを検出)", async () => {
      // route を経由すると「既定と同値なら削除」されるため到達できない状態
      // ——リポジトリを直接叩いて、行が「存在するのに実効時刻は既定と同じ」
      // 状態を人為的に作る。実装が「行がある ⇒ overridden: true」という
      // 誤った判定に退行していないかを検出する。
      upsertOverride(db, TODAY_KEY, "evening", "18:00"); // 既定と同値
      const rowCountBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as count FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
          )
          .get(TODAY_KEY, "evening") as { count: number }
      ).count;
      expect(rowCountBefore).toBe(1);
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.time).toBe("18:00");
      expect(body.evening.overridden).toBe(false);
    });

    it("falls back to the default and reports overridden: false when a stored override exceeds the delay limit (AC-5 at the API layer, PUT を経由しない直挿入で検証)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // 恒常設定 18:00 の上限は 21:00。22:00 は PUT では拒否されるため、
      // リポジトリを直接叩いて「保存済みの上限超過値」を人為的に作る。
      upsertOverride(db, TODAY_KEY, "evening", "22:00");
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.time).toBe("18:00");
      expect(body.evening.overridden).toBe(false);
      warnSpy.mockRestore();
    });

    it("returns latestAllowedTime equal to latestAllowedMeetingTime(defaultTime) (AC-29)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.morning.latestAllowedTime).toBe("12:00"); // 09:00 + 180min
      expect(body.evening.latestAllowedTime).toBe("21:00"); // 18:00 + 180min
    });

    it("returns 400 invalid_date for a malformed date (AC-41)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/meeting-schedule/not-a-date");

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("invalid_date");
    });

    it("returns 400 invalid_date for a non-existent calendar day", async () => {
      const app = createApp(db);

      const res = await app.request("/api/meeting-schedule/2026-02-30");

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("invalid_date");
    });

    it("returns 400 not_today when :date is not today (AC-40)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${YESTERDAY_KEY}`);

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("not_today");
    });

    it("reflects an overridden constant setting (morning_meeting_time) as defaultTime", async () => {
      setSettingValue(db, "morning_meeting_time", "08:30");
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.morning.defaultTime).toBe("08:30");
      expect(body.morning.time).toBe("08:30");
    });
  });

  describe("PUT /api/meeting-schedule/:date", () => {
    it("returns the specified time as the effective time in the response (AC-30)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.time).toBe("20:00");
    });

    it("persists the specified time so a subsequent GET returns it (AC-31)", async () => {
      const app = createApp(db);
      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`);

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.time).toBe("20:00");
    });

    it("does not persist an override row when the specified time equals the constant setting (AC-28)", async () => {
      const app = createApp(db);

      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "18:00" }), // 恒常設定と同じ
      });

      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get(TODAY_KEY, "evening") as { count: number };
      expect(row.count).toBe(0);
    });

    it("deletes an existing override row when a later PUT specifies the constant setting's time", async () => {
      const app = createApp(db);
      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "18:00" }),
      });

      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get(TODAY_KEY, "evening") as { count: number };
      expect(row.count).toBe(0);
    });

    it("sets overridden: false in the response when null is specified (AC-32)", async () => {
      const app = createApp(db);
      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: null }),
      });

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.evening.overridden).toBe(false);
      expect(body.evening.time).toBe("18:00");
    });

    it("leaves the time of a type not present in the body unchanged (AC-33)", async () => {
      const app = createApp(db);
      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morning: "07:00" }),
      });

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      const body = await readJson<MeetingScheduleBody>(res);
      expect(body.morning.time).toBe("07:00"); // 前回の PUT の値のまま
      expect(body.evening.time).toBe("20:00");
    });

    it("keeps the row count at 1 when PUT is sent twice for the same date and type (AC-34)", async () => {
      const app = createApp(db);
      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:30" }),
      });

      const row = db
        .prepare(
          "SELECT COUNT(*) as count FROM meeting_time_overrides WHERE date = ? AND meeting_type = ?",
        )
        .get(TODAY_KEY, "evening") as { count: number };
      expect(row.count).toBe(1);
    });

    it("returns 400 delay_limit_exceeded for a time past the limit (AC-35)", async () => {
      const app = createApp(db);

      // 恒常設定 18:00 の上限は 21:00。22:00 は超過。
      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "22:00" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("delay_limit_exceeded");
    });

    it("does not persist the other type when one type in the same request exceeds the limit (AC-36)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ morning: "07:00", evening: "22:00" }), // evening が超過
      });

      expect(res.status).toBe(400);
      const rows = db
        .prepare("SELECT COUNT(*) as count FROM meeting_time_overrides WHERE date = ?")
        .get(TODAY_KEY) as { count: number };
      expect(rows.count).toBe(0);
    });

    it("returns 400 invalid_time for a value that is not HH:mm nor null (AC-37)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "9pm" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("invalid_time");
    });

    it("returns 400 invalid_request for a body containing a key other than morning/evening (AC-38)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00", afternoon: "15:00" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("invalid_request");
    });

    it("returns 400 invalid_request when the body is not a JSON object", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${TODAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["evening", "20:00"]),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("invalid_request");
    });

    it("returns 400 not_today when :date is not today (AC-39)", async () => {
      const app = createApp(db);

      const res = await app.request(`/api/meeting-schedule/${YESTERDAY_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evening: "20:00" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.code).toBe("not_today");
    });
  });

  describe("既存契約の保全", () => {
    it("GET /api/settings still returns the constant setting even when today has an override (AC-52)", async () => {
      upsertOverride(db, TODAY_KEY, "morning", "07:00");
      upsertOverride(db, TODAY_KEY, "evening", "21:00");
      const app = createApp(db);

      const res = await app.request("/api/settings");

      expect(res.status).toBe(200);
      const body = await readJson<{ morning_meeting_time: string; evening_meeting_time: string }>(
        res,
      );
      expect(body.morning_meeting_time).toBe("09:00");
      expect(body.evening_meeting_time).toBe("18:00");
    });
  });
});
