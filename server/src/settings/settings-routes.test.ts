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
  evidence_enforcement_enabled: boolean;
  morning_mentoring_required: boolean;
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
        evidence_enforcement_enabled: false,
        morning_mentoring_required: true,
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

    // エビデンス強制設定（#386）。AC-7〜AC-11。
    describe("evidence_enforcement_enabled", () => {
      it("GET returns false by default when the key is unset (AC-7)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings");

        const body = await readJson<SettingsBody>(res);
        expect(body.evidence_enforcement_enabled).toBe(false);
      });

      it('PUT true stores the string "true" in the settings table (AC-8)', async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_enforcement_enabled: true }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("evidence_enforcement_enabled") as { value: string } | undefined;
        expect(row?.value).toBe("true");
      });

      it("GET reflects true immediately after PUT true (AC-9)", async () => {
        const app = createApp(db);

        await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_enforcement_enabled: true }),
        });

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.evidence_enforcement_enabled).toBe(true);
      });

      it.each([["true"], [1], [null]])(
        "PUT rejects a non-boolean value (%s) with 400 (AC-10)",
        async (value) => {
          const app = createApp(db);

          const res = await app.request("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ evidence_enforcement_enabled: value }),
          });

          expect(res.status).toBe(400);
        },
      );

      it("PUT saves no keys at all when evidence_enforcement_enabled is invalid, even if other keys in the same request are valid (AC-11)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boss_name: "鬼上司",
            evidence_enforcement_enabled: "true",
          }),
        });

        expect(res.status).toBe(400);

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.boss_name).toBe("ボス");
        expect(body.evidence_enforcement_enabled).toBe(false);
      });
    });

    // 朝会メンタリング必須設定（#406）。AC-31〜AC-37。既定値の向きが
    // evidence_enforcement_enabled とは逆（未設定・不正値は true）である点に
    // 注意。
    describe("morning_mentoring_required", () => {
      it("GET includes the key and returns true by default when unset (AC-31, AC-32)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings");

        const body = await readJson<SettingsBody>(res);
        expect(body).toHaveProperty("morning_mentoring_required");
        expect(body.morning_mentoring_required).toBe(true);
      });

      it('PUT false stores the string "false" in the settings table (AC-33, AC-36)', async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: false }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("morning_mentoring_required") as { value: string } | undefined;
        expect(row?.value).toBe("false");
      });

      // AC-36 のもう一方の側。false 側だけを DB で確かめると、値を
      // 書き分けず常に "false" を書く実装でも通ってしまう。
      it('PUT true stores the string "true" in the settings table (AC-36)', async () => {
        const app = createApp(db);

        // いったん false にしてから true へ戻す（未設定のままだと行が
        // 作られず、"true" が書かれたことを確かめられないため）。
        await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: false }),
        });

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: true }),
        });

        expect(res.status).toBe(200);
        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("morning_mentoring_required") as { value: string } | undefined;
        expect(row?.value).toBe("true");
      });

      it("GET reflects false immediately after PUT false", async () => {
        const app = createApp(db);

        await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: false }),
        });

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.morning_mentoring_required).toBe(false);
      });

      it('PUT rejects the string "true" with 400 (AC-34)', async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: "true" }),
        });

        expect(res.status).toBe(400);
      });

      it("PUT rejects null with 400 (AC-35)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ morning_mentoring_required: null }),
        });

        expect(res.status).toBe(400);
      });

      it("GET returns true when the stored value is not \"true\"/\"false\" (AC-37)", async () => {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "morning_mentoring_required",
          "yes",
        );
        const app = createApp(db);

        const res = await app.request("/api/settings");

        const body = await readJson<SettingsBody>(res);
        expect(body.morning_mentoring_required).toBe(true);
      });
    });

    // work_start / work_end 相関チェック（#480, 親要件 #448 決定1・2）。
    // settings-validation.test.ts が関数レベルで担保している境界を、実DB
    // 経由の HTTP ルートでも確認する（GAP-13 と同じ狙い: readJsonBody ->
    // validatePutSettingsInput -> setSettingValue の配線が壊れても検出
    // できるように）。AC-6（拒否時は work_start/work_end のどちらも書き
    // 込まれない）は GET のフォールバック値ではなく settings テーブルの
    // 生の行を直接見て確認する。
    describe("work_start / work_end correlation (AC-1, AC-2, AC-5, AC-6)", () => {
      // 09:00/18:00 は既定値と一致するため、GET のフォールバック経由でも
      // 同じレスポンスになり「実際に書き込まれた」ことの検出力が無い
      // （self-review 指摘）。既定値と異なる 08:30/17:30 を使い、かつ
      // settings テーブルの生の行を直接見て、書き込みそのものを確認する。
      it("returns 200 and saves both keys for a valid range (work_start=08:30, work_end=17:30) (AC-5)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "08:30", work_end: "17:30" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.work_start).toBe("08:30");
        expect(body.work_end).toBe("17:30");

        const workStartRow = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_start") as { value: string } | undefined;
        const workEndRow = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_end") as { value: string } | undefined;
        expect(workStartRow?.value).toBe("08:30");
        expect(workEndRow?.value).toBe("17:30");
      });

      it("returns 400 for an overnight range (work_start=22:00, work_end=02:00) (AC-1)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "22:00", work_end: "02:00" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("work_start");
        expect(body.error).toContain("work_end");
      });

      it("returns 400 for an equal-time range (work_start=09:00, work_end=09:00) (AC-1, decision 2: >=)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "09:00", work_end: "09:00" }),
        });

        expect(res.status).toBe(400);
      });

      it("writes neither work_start nor work_end to the settings table when the range is rejected (AC-6)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "22:00", work_end: "02:00" }),
        });
        expect(res.status).toBe(400);

        const workStartRow = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_start") as { value: string } | undefined;
        const workEndRow = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_end") as { value: string } | undefined;
        expect(workStartRow).toBeUndefined();
        expect(workEndRow).toBeUndefined();

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.work_start).toBe("09:00");
        expect(body.work_end).toBe("18:00");
      });

      it("rejects the whole patch (also leaving boss_name unsaved) when the working-hours correlation is invalid, even alongside other valid keys (all-or-nothing)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boss_name: "鬼上司",
            work_start: "22:00",
            work_end: "02:00",
          }),
        });
        expect(res.status).toBe(400);

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.boss_name).toBe("ボス");
      });
    });

    // 部分更新時の相関チェック配線（#481, 親要件 #448 決定1・6）。片方だけ
    // を送る更新でも、送られなかった側の「保存後に実際に DB へ入る生の
    // 値」（未設定なら既定値 09:00/18:00）との組み合わせで
    // work_start >= work_end になる場合は拒否する。除外側・包含側の両方向
    // と、既に不正な生値が保存されているケースでの基準（フォールバック
    // 適用後の値ではなく生値）、および相関チェックが patch に触れていない
    // ときは発火しないスコープをそれぞれ担保する。
    describe("work_start / work_end partial-update correlation (AC-3, AC-4)", () => {
      it("returns 400 when work_start alone is pushed past the currently-effective (default) work_end (AC-3, exclusion side)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "20:00" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("work_start");
        expect(body.error).toContain("work_end");

        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_start") as { value: string } | undefined;
        expect(row).toBeUndefined();
      });

      it("returns 200 and saves work_start alone when it stays before the default work_end (AC-3, inclusion side)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "07:00" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.work_start).toBe("07:00");
        expect(body.work_end).toBe("18:00");
      });

      it("returns 400 for work_end alone when work_start is unset and the default work_start would be >= it (AC-4)", async () => {
        // Issue #481 の完了条件に挙げられている具体例そのもの:
        // work_start 未設定の DB への { work_end: "02:00" } のみの更新は
        // 既定値 09:00 と突き合わされ拒否される。
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_end: "02:00" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("work_start");
        expect(body.error).toContain("work_end");

        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_end") as { value: string } | undefined;
        expect(row).toBeUndefined();
      });

      it("returns 200 and saves work_end alone when it stays after the default work_start (AC-4, inclusion side)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_end: "20:00" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.work_start).toBe("09:00");
        expect(body.work_end).toBe("20:00");
      });

      it("rejects the whole patch (also leaving boss_name unsaved) when a partial update fails the correlation check, even alongside other valid keys (all-or-nothing)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_name: "鬼上司", work_start: "20:00" }),
        });

        expect(res.status).toBe(400);

        const getRes = await app.request("/api/settings");
        const body = await readJson<SettingsBody>(getRes);
        expect(body.boss_name).toBe("ボス");
      });

      // self-review 指摘: このテストの入力（work_end="02:00"）は TIME_PATTERN
      // に一致する書式のため、現行の loadDetectionSettings はこの値を
      // フォールバックせずそのまま返す（フォールバックは書式不正なときの
      // み発生する）。そのため本テストは「getSettingValue の生値を基準に
      // している」ことと「loadDetectionSettings 由来の実効値を基準にして
      // いる」ことを挙動レベルで判別できない（#448 決定1で要求される
      // Issue #481 記載の具体シナリオを固定する回帰テストではあるが、
      // 実装の読み出し先を取り違えても緑のままになりうる）。誤解を招く
      // 名前を避け、実際に担保している内容（この具体シナリオでの拒否）
      // に即した説明へ改めた。
      it("rejects work_start alone against the other key's already-saved raw value, per the concrete scenario in Issue #481's completion criteria (work_start=22:00 / work_end=02:00 stored, PUT work_start=10:00)", async () => {
        // #480 のバリデータを経由せず直接 INSERT して、PUT 単体では作れない
        // 「既に不正な組み合わせ（work_start=22:00 / work_end=02:00）が
        // 保存された」状態を作る。work_start=10:00 は work_end の既定値
        // 18:00 と比べれば正当に見えるが、実際に保存されている生の
        // work_end (02:00) と比べると 10:00 >= 02:00 のため不正。
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "work_start",
          "22:00",
        );
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "work_end",
          "02:00",
        );
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "10:00" }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("work_start");
        expect(body.error).toContain("work_end");

        // all-or-nothing: 既存の生値も 10:00 で上書きされず、22:00 のまま
        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_start") as { value: string } | undefined;
        expect(row?.value).toBe("22:00");
      });

      // self-review 指摘: 送られなかった側の生値が「書式不正」（DB 直接
      // 操作でのみ到達可能。PUT 経由では validateTime が弾くため作れない）
      // だと、isValidWorkingHoursRange は仕様どおり fail-open（true）を
      // 返すため、相関チェックが無条件で素通りしていた。既定値へ倒す
      // ことで、書式不正な生値を「未設定」と同じ扱いにし、fail-open に
      // よって保存後に実効的な空区間（例: 10:00〜"25:99" 相当の未定義な
      // 区間ではなく、実際には既定 09:00/18:00 側にフォールバックされる
      // ため 20:00〜18:00 のような空区間）が書き込まれることを防ぐ。
      it("falls back to the default when the other key's raw stored value is not a valid \"HH:mm\" (format-invalid, DB-direct-write-only scenario)", async () => {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "work_end",
          "25:99",
        );
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ work_start: "20:00" }),
        });

        // work_end の生値 "25:99" は書式不正なので既定値 18:00 として扱う。
        // 20:00 >= 18:00 のため拒否される（fail-open で無条件通過しない）。
        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(body.error).toContain("work_start");
        expect(body.error).toContain("work_end");

        const row = db
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("work_start") as { value: string } | undefined;
        expect(row).toBeUndefined();
      });

      it("does not run the correlation check when the patch touches neither work_start nor work_end, even if an invalid raw pair is already stored", async () => {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "work_start",
          "22:00",
        );
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          "work_end",
          "02:00",
        );
        const app = createApp(db);

        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_name: "鬼上司" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<SettingsBody>(res);
        expect(body.boss_name).toBe("鬼上司");
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
