import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { loadDetectionSettings } from "../scheduler/detection-settings.js";
import { DEFAULT_MODEL } from "../llm/claude-client.js";
import { MIN_STRICTNESS, MAX_STRICTNESS } from "../boss/persona-prompt.js";

// The `*_minutes` keys all share the same `validatePositiveIntegerMinutes`
// validator (settings-validation.ts), so their HTTP-level boundary behavior
// is exercised once per key here rather than duplicating the same
// assertions by hand.
const MINUTE_KEYS = [
  "detection_unstarted_fallback_minutes",
  "detection_silence_fallback_minutes",
  "detection_break_fallback_minutes",
  "escalation_l2_after_minutes",
  "escalation_l3_after_minutes",
  "escalation_repeat_minutes",
] as const;

interface ErrorBody {
  error: string;
}

interface SettingsBody {
  boss_name: string;
  boss_tone_preset: string;
  boss_strictness: number;
  boss_custom_instructions: string | null;
  work_start: string;
  work_end: string;
  morning_meeting_time: string;
  evening_meeting_time: string;
  detection_unstarted_fallback_minutes: number;
  detection_silence_fallback_minutes: number;
  detection_break_fallback_minutes: number;
  escalation_l2_after_minutes: number;
  escalation_l3_after_minutes: number;
  escalation_repeat_minutes: number;
  model: string;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("settings routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /api/settings", () => {
    it("returns default effective values when nothing is set", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings");

      expect(res.status).toBe(200);
      const body = await readJson<SettingsBody>(res);
      expect(body).toEqual({
        boss_name: "ボス",
        boss_tone_preset: "reliable",
        boss_strictness: 3,
        boss_custom_instructions: null,
        work_start: "09:00",
        work_end: "18:00",
        morning_meeting_time: "09:00",
        evening_meeting_time: "18:00",
        detection_unstarted_fallback_minutes: 60,
        detection_silence_fallback_minutes: 45,
        detection_break_fallback_minutes: 15,
        escalation_l2_after_minutes: 15,
        escalation_l3_after_minutes: 10,
        escalation_repeat_minutes: 10,
        model: DEFAULT_MODEL,
      });
    });

    it("falls back to defaults for stored invalid values (e.g. an out-of-range strictness)", async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "boss_strictness",
        "99",
      );
      const app = createApp(db);

      const res = await app.request("/api/settings");

      const body = await readJson<SettingsBody>(res);
      expect(body.boss_strictness).toBe(3);
    });

    // Issue #121 self-review: `boss-comment-cache.ts`'s dashboard_comment_*
    // keys (derived cache, not a user setting) rely on `readEffectiveSettings`
    // being an allowlist (explicit key enumeration) to stay excluded from
    // this response. This test locks that invariant in explicitly, rather
    // than leaving it to be enforced only implicitly by the `toEqual` above.
    it("excludes the dashboard boss-comment cache keys (derived cache, not a user setting)", async () => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "dashboard_comment_date",
        "2026-07-06",
      );
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "dashboard_comment_fingerprint",
        "some-fingerprint",
      );
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
        "dashboard_comment_text",
        "今日も淡々とやれ",
      );
      const app = createApp(db);

      const res = await app.request("/api/settings");

      const body = (await readJson<Record<string, unknown>>(res)) as Record<
        string,
        unknown
      >;
      // キーごとに検証する。arrayContaining の否定は「3キーすべてが露出した
      // ときだけ」失敗するため、1〜2キーだけ漏れる回帰を素通りさせる。
      expect(body).not.toHaveProperty("dashboard_comment_date");
      expect(body).not.toHaveProperty("dashboard_comment_fingerprint");
      expect(body).not.toHaveProperty("dashboard_comment_text");
    });
  });

  describe("PUT /api/settings", () => {
    it("updates only the provided key, leaving the rest at defaults", async () => {
      const app = createApp(db);

      const putRes = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_name: "鬼上司" }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await app.request("/api/settings");
      const body = await readJson<SettingsBody>(getRes);
      expect(body.boss_name).toBe("鬼上司");
      expect(body.boss_tone_preset).toBe("reliable");
    });

    it("updates multiple keys at once", async () => {
      const app = createApp(db);

      await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boss_tone_preset: "strict",
          boss_strictness: 5,
          work_start: "08:00",
        }),
      });

      const res = await app.request("/api/settings");
      const body = await readJson<SettingsBody>(res);
      expect(body.boss_tone_preset).toBe("strict");
      expect(body.boss_strictness).toBe(5);
      expect(body.work_start).toBe("08:00");
    });

    it("is reflected by resolveBossSettings and loadDetectionSettings directly", async () => {
      const app = createApp(db);

      await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boss_name: "スパルタ上司",
          escalation_l2_after_minutes: 5,
        }),
      });

      const bossSettings = resolveBossSettings(db);
      expect(bossSettings.persona.name).toBe("スパルタ上司");

      const detectionSettings = loadDetectionSettings(db);
      expect(detectionSettings.escalation.level1ToLevel2Minutes).toBe(5);
    });

    it("resets boss_custom_instructions to null when set to an empty string", async () => {
      const app = createApp(db);

      await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_custom_instructions: "丁寧に" }),
      });
      const afterSet = await readJson<SettingsBody>(
        await app.request("/api/settings"),
      );
      expect(afterSet.boss_custom_instructions).toBe("丁寧に");

      await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_custom_instructions: "" }),
      });
      const afterReset = await readJson<SettingsBody>(
        await app.request("/api/settings"),
      );
      expect(afterReset.boss_custom_instructions).toBeNull();
    });

    it("accepts boss_custom_instructions: null (round-tripping GET's response back into PUT)", async () => {
      const app = createApp(db);

      // A settings screen commonly re-sends the exact object it got from
      // GET; GET returns null for an unset boss_custom_instructions, so PUT
      // must accept null too (not just "") or an untouched field would
      // break the whole save (all-or-nothing).
      const getRes = await app.request("/api/settings");
      const current = await readJson<SettingsBody>(getRes);
      expect(current.boss_custom_instructions).toBeNull();

      const putRes = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current),
      });

      expect(putRes.status).toBe(200);
      const body = await readJson<SettingsBody>(putRes);
      expect(body.boss_custom_instructions).toBeNull();
    });

    it("returns 400 and saves nothing when a value is invalid (all-or-nothing)", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boss_name: "鬼上司",
          boss_strictness: 99,
        }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");

      const getRes = await app.request("/api/settings");
      const getBody = await readJson<SettingsBody>(getRes);
      expect(getBody.boss_name).toBe("ボス");
    });

    it("returns 400 for an unrecognized key", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ not_a_real_key: "x" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when the request body is not valid JSON", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 for an invalid time format", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_start: "9:00" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for a negative minutes value", async () => {
      const app = createApp(db);

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ escalation_repeat_minutes: -5 }),
      });

      expect(res.status).toBe(400);
    });

    // GAP-13: settings-validation.test.ts already covers these boundaries at
    // the function level; the checks below repeat them through the real
    // HTTP route (readJsonBody -> validatePutSettingsInput -> setSettingValue)
    // so a broken route/validator wiring would be caught even if the
    // validator itself stays correct. Both sides of each boundary are
    // asserted (inside accepted, outside rejected) so neither an
    // always-400 nor an always-200 handler could pass.
    describe("boss_strictness boundary", () => {
      it(`returns 400 for ${MIN_STRICTNESS - 1} (one below the minimum)`, async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_strictness: MIN_STRICTNESS - 1 }),
        });

        expect(res.status).toBe(400);
      });

      it(`returns 200 and saves ${MIN_STRICTNESS} (the minimum)`, async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_strictness: MIN_STRICTNESS }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.boss_strictness).toBe(MIN_STRICTNESS);
      });

      it(`returns 200 and saves ${MAX_STRICTNESS} (the maximum)`, async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_strictness: MAX_STRICTNESS }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.boss_strictness).toBe(MAX_STRICTNESS);
      });

      it(`returns 400 for ${MAX_STRICTNESS + 1} (one above the maximum)`, async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_strictness: MAX_STRICTNESS + 1 }),
        });

        expect(res.status).toBe(400);
      });
    });

    describe.each(MINUTE_KEYS)("%s boundary", (key) => {
      it("returns 400 for 0", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: 0 }),
        });

        expect(res.status).toBe(400);
      });

      it("returns 200 and saves 1", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: 1 }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<Record<string, unknown>>(res);
        expect(body[key]).toBe(1);
      });

      it("returns 400 for a non-integer (1.5)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: 1.5 }),
        });

        expect(res.status).toBe(400);
      });
    });
  });
});
