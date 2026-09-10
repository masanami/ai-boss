import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { setSettingValue } from "../settings/settings-repository.js";
import type { Task } from "./task.js";
import { toDateKey } from "../detection/time-utils.js";

interface ErrorBody {
  error: string;
  code?: string;
}

function enableEnforcement(db: Database.Database): void {
  setSettingValue(db, "evidence_enforcement_enabled", "true");
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("tasks routes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  describe("GET /api/tasks", () => {
    it("returns an empty array when no tasks exist", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks");

      expect(res.status).toBe(200);
      expect(await readJson<Task[]>(res)).toEqual([]);
    });

    it("returns all tasks ordered by created_at ascending", async () => {
      const app = createApp(db);

      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "1つ目" }),
      });
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "2つ目" }),
      });

      const res = await app.request("/api/tasks");

      expect(res.status).toBe(200);
      const body = await readJson<Task[]>(res);
      expect(body.map((t) => t.title)).toEqual(["1つ目", "2つ目"]);
    });
  });

  describe("POST /api/tasks", () => {
    it("creates a task with only a title, filling in defaults", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "牛乳を買う" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        title: "牛乳を買う",
        description: null,
        category: "work",
        priority: null,
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
        completed_at: null,
      });
      expect(typeof body.id).toBe("number");
      expect(typeof body.created_at).toBe("string");
      expect(typeof body.updated_at).toBe("string");
    });

    it("creates a task with all optional fields set", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "資料を作る",
          description: "月次報告資料",
          category: "work",
          priority: "high",
          due_at: "2026-07-10",
          status: "in_progress",
          boss_comment: "先にこれをやれ",
          estimated_minutes: 90,
        }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        title: "資料を作る",
        description: "月次報告資料",
        category: "work",
        priority: "high",
        due_at: "2026-07-10",
        status: "in_progress",
        boss_comment: "先にこれをやれ",
        estimated_minutes: 90,
      });
    });

    it("returns 400 with a machine-readable error when title is missing", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when title is an empty string", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when status is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", status: "not-a-status" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when priority is invalid", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", priority: "urgent" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when estimated_minutes is not a non-negative integer", async () => {
      const app = createApp(db);

      for (const invalid of ["abc", -5, 1.5]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", estimated_minutes: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("returns 400 when description is not a string", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "タスク", description: 123 }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when boss_comment is not a string or null", async () => {
      const app = createApp(db);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", boss_comment: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("returns 400 when due_at is not a string or null", async () => {
      const app = createApp(db);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    // due_at の**形式**不正（#199 / GAP-34）。型が string でも暦として解釈
    // できない値を通すと、`detection/deadline-overdue.ts` が
    // `new Date(due_at).getTime()` を NaN にして期限超過を永久に検知せず、
    // `detection/priority.ts` の並び順にも NaN が混入する。
    it("returns 400 when due_at is a string that is not a valid ISO 8601 date or date-time", async () => {
      const app = createApp(db);

      for (const invalid of [
        "not-a-date-at-all",
        "0",
        "2026",
        "12/31/2026",
        "2026-02-30",
        "2026-13-01",
        "2026-09-05T24:00",
      ]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: invalid }),
        });

        expect(res.status, invalid).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    // Codex 指摘（PR #458 P2）: 受理と解釈の非対称。`isValidIsoDateOrDateTime`
    // は 0000〜0099 の 4 桁年を**実在の暦日として受理する**（`lib/iso-date.ts` は
    // `daysInMonth` で意図的にこの範囲を正しく扱っている）が、暦日ユーティリティ
    // 側は多引数 `Date` コンストラクタの 1900 年代への写像に阻まれて解釈できない。
    // その結果 201 が返るのに `due_at` は `null` として保存され、**利用者の締切が
    // 黙って消えていた**（ADR 0010 決定 6 が避けようとした事象そのもの）。
    //
    // 「受理するなら解釈する／解釈しないなら受理側で弾く」に揃え、後者を採る。
    it("returns 400 when due_at cannot be interpreted as a local calendar day", async () => {
      const app = createApp(db);

      for (const unsupported of [
        "0099-12-31",
        "0001-01-01",
        "0000-02-29",
        "0099-12-31T10:00:00Z",
      ]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: unsupported }),
        });

        expect(res.status, unsupported).toBe(400);
      }
    });

    // 上の裏返し。「解釈できない値は弾く」を入れたことで、**解釈できる値まで
    // 巻き込んで弾いていない**ことを確かめる（弾きすぎの検出）。
    it("still accepts due_at values that can be interpreted", async () => {
      const app = createApp(db);

      for (const supported of ["2026-09-05", "0100-01-01", "1970-01-01"]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: supported }),
        });

        expect(res.status, supported).toBe(201);
        const body = await readJson<{ due_at: string | null }>(res);
        expect(body.due_at, supported).toBe(supported);
      }
    });

    // AC-14: 時刻付きの旧形式は**拒否せず**受理し、その瞬時のローカル暦日へ
    // 正規化して保存する（ADR 0010 決定 3・4）。保存形式は "YYYY-MM-DD" の 1 つ。
    it("normalizes the due_at shapes the web date input and the boss tool produce to a local calendar day", async () => {
      const app = createApp(db);

      for (const valid of [
        "2026-09-05",
        "2026-09-05T09:30",
        "2026-09-05T09:30:00.000Z",
        "2026-09-05T09:30:00+09:00",
      ]) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", due_at: valid }),
        });

        expect(res.status, valid).toBe(201);
        const body = await readJson<{ due_at: string | null }>(res);

        // 期待値はハードコードしない。オフセット付きの値は実行 TZ によって
        // ローカル暦日が変わるため（"2026-09-05T09:30:00+09:00" は UTC 00:30 で、
        // America/New_York では 9/4 になる）。日付のみの値は既に暦日キーそのもの
        // なので Date を経由させない（経由すると UTC 0 時解釈で前日になる）。
        const expected = /^\d{4}-\d{2}-\d{2}$/.test(valid)
          ? valid
          : toDateKey(new Date(valid));

        expect(body.due_at, valid).toBe(expected);
        expect(body.due_at, valid).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it("sets completed_at when a task is created directly with status done", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "完了済みで登録", status: "done" }),
      });

      expect(res.status).toBe(201);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("done");
      expect(typeof body.completed_at).toBe("string");
    });

    it("returns 400 when the request body is not valid JSON", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    // 機能仕様 docs/features/completion-evidence-enforcement.md 決定2・決定3
    describe("evidence_required（Issue #389）", () => {
      it("defaults evidence_required to false when omitted (AC-12)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク" }),
        });

        expect(res.status).toBe(201);
        const body = await readJson<Task>(res);
        expect(body.evidence_required).toBe(false);
      });

      it("accepts evidence_required: true (AC-13)", async () => {
        const app = createApp(db);

        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", evidence_required: true }),
        });

        expect(res.status).toBe(201);
        const body = await readJson<Task>(res);
        expect(body.evidence_required).toBe(true);
      });

      it("returns 400 when evidence_required is not a boolean (AC-14)", async () => {
        const app = createApp(db);

        for (const invalid of [1, "true"]) {
          const res = await app.request("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "タスク", evidence_required: invalid }),
          });

          expect(res.status, JSON.stringify(invalid)).toBe(400);
          const body = await readJson<ErrorBody>(res);
          expect(typeof body.error).toBe("string");
        }
      });

      // GET /api/tasks の各要素の evidence_required は boolean である（AC-18）
      it("evidence_required round-trips as boolean through GET /api/tasks (AC-18)", async () => {
        const app = createApp(db);
        await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", evidence_required: true }),
        });

        const res = await app.request("/api/tasks");
        const body = await readJson<Task[]>(res);

        expect(body).toHaveLength(1);
        expect(body[0].evidence_required).toBe(true);
        expect(typeof body[0].evidence_required).toBe("boolean");
      });

      // 決定 2-h: POST /api/tasks が status: "done" を直接指定する「第5の経路」
      it("returns 409 with code evidence_required for a direct-done create when enforcement is on, evidence is required, and there is no evidence (AC-34)", async () => {
        enableEnforcement(db);
        const app = createApp(db);

        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "タスク",
            status: "done",
            evidence_required: true,
          }),
        });

        expect(res.status).toBe(409);
        const body = await readJson<ErrorBody>(res);
        expect(body.code).toBe("evidence_required");
      });

      it("does not create a task row when the direct-done create is rejected (AC-34)", async () => {
        enableEnforcement(db);
        const app = createApp(db);

        await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "タスク",
            status: "done",
            evidence_required: true,
          }),
        });

        const res = await app.request("/api/tasks");
        expect(await readJson<Task[]>(res)).toEqual([]);
      });

      it("allows a direct-done create when enforcement is on but evidence_required is false", async () => {
        enableEnforcement(db);
        const app = createApp(db);

        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", status: "done" }),
        });

        expect(res.status).toBe(201);
      });
    });
  });

  describe("PATCH /api/tasks/:id", () => {
    it("returns 404 for a non-existent id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks/9999", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新" }),
      });

      expect(res.status).toBe(404);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 404 for a non-numeric id", async () => {
      const app = createApp(db);

      const res = await app.request("/api/tasks/not-a-number", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新" }),
      });

      expect(res.status).toBe(404);
    });

    // POST 側と同じ形式検証が PATCH 経路にも効くこと（両経路とも
    // `validateOptionalFieldTypes` を通るが、片方だけ結線される回帰を防ぐ）。
    it("returns 400 when due_at is patched to a string that is not a valid ISO 8601 date or date-time", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      for (const invalid of ["not-a-date-at-all", "2026-02-30", "2026"]) {
        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ due_at: invalid }),
        });

        expect(res.status, invalid).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }

      const after = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ due_at: "2026-09-05" }),
      });
      expect(after.status).toBe(200);
      expect((await readJson<Task>(after)).due_at).toBe("2026-09-05");
    });

    it("partially updates only the specified fields, keeping the rest", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク", description: "元の詳細" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "high" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body).toMatchObject({
        id: created.id,
        title: "元のタスク",
        description: "元の詳細",
        priority: "high",
      });
    });

    it("updates updated_at when a task is patched", async () => {
      const app = createApp(db);
      // created_at と updated_at が同一ミリ秒だと「値が進む」が成立せず
      // 環境依存でフレークするため、作成時刻と PATCH 時刻を明示的にずらす
      // (ローカル日付基準・TZ非依存。UTC文字列リテラルの直書きは禁止)
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 1, 9, 0));

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      vi.setSystemTime(new Date(2026, 5, 1, 9, 5));

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "更新後" }),
      });

      const body = await readJson<Task>(res);
      expect(typeof body.updated_at).toBe("string");
      expect(body.updated_at).not.toBe("");
      expect(new Date(body.updated_at).getTime()).toBeGreaterThan(
        new Date(created.updated_at).getTime(),
      );
      expect(created.created_at).toBe(body.created_at);
    });

    it("returns 400 when status is invalid", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "archived" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when priority is invalid", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: "urgent" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when boss_comment is patched to a non-string, non-null value", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      for (const invalid of [123, true, [], {}]) {
        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ boss_comment: invalid }),
        });

        expect(res.status).toBe(400);
        const body = await readJson<ErrorBody>(res);
        expect(typeof body.error).toBe("string");
      }
    });

    it("updates boss_comment when patched with a valid string (guards against an always-400 implementation)", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boss_comment: "先にこれをやれ" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.boss_comment).toBe("先にこれをやれ");
    });

    it("returns 400 when title is patched to an empty string", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 when category is included in the patch", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "hobby" }),
      });

      expect(res.status).toBe(400);
      const body = await readJson<ErrorBody>(res);
      expect(body.error).toContain("category");
    });

    it("sets completed_at when status transitions to done", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);
      expect(created.completed_at).toBeNull();

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("done");
      expect(typeof body.completed_at).toBe("string");
    });

    it("clears completed_at when status transitions away from done", async () => {
      const app = createApp(db);

      const createRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "元のタスク" }),
      });
      const created = await readJson<Task>(createRes);

      await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });

      const res = await app.request(`/api/tasks/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });

      expect(res.status).toBe(200);
      const body = await readJson<Task>(res);
      expect(body.status).toBe("in_progress");
      expect(body.completed_at).toBeNull();
    });

    // 機能仕様 docs/features/completion-evidence-enforcement.md 決定2
    describe("evidence_required の完了ゲート（Issue #389）", () => {
      async function createTask(app: ReturnType<typeof createApp>, evidenceRequired: boolean) {
        const res = await app.request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タスク", evidence_required: evidenceRequired }),
        });
        return readJson<Task>(res);
      }

      it("returns 409 with code evidence_required when enforcement is on, evidence is required, and there is no evidence (AC-23/AC-24)", async () => {
        enableEnforcement(db);
        const app = createApp(db);
        const created = await createTask(app, true);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });

        expect(res.status).toBe(409);
        const body = await readJson<ErrorBody>(res);
        expect(body.code).toBe("evidence_required");
      });

      it("leaves status and completed_at unchanged after a 409 (AC-25/AC-26)", async () => {
        enableEnforcement(db);
        const app = createApp(db);
        const created = await createTask(app, true);

        await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });

        const res = await app.request("/api/tasks");
        const [task] = await readJson<Task[]>(res);
        expect(task.status).toBe("todo");
        expect(task.completed_at).toBeNull();
      });

      it("allows completion when enforcement is off (AC-28)", async () => {
        const app = createApp(db);
        const created = await createTask(app, true);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });

        expect(res.status).toBe(200);
      });

      it("allows completion when evidence_required is false (AC-29)", async () => {
        enableEnforcement(db);
        const app = createApp(db);
        const created = await createTask(app, false);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });

        expect(res.status).toBe(200);
      });

      // 決定 2-a（AC-35）: 遡及しない — 既に done のタスクへの他フィールドの
      // PATCH はゲートを通らない
      it("does not retroactively block a title-only patch on an already-done task (AC-35)", async () => {
        enableEnforcement(db);
        const app = createApp(db);
        const created = await createTask(app, true);
        // 一旦 enforcement を切って done にする（このテストの前提を作るため）
        setSettingValue(db, "evidence_enforcement_enabled", "false");
        await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        });
        enableEnforcement(db);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "更新後のタイトル" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<Task>(res);
        expect(body.title).toBe("更新後のタイトル");
        expect(body.status).toBe("done");
      });

      // 決定 2-c（AC-36/AC-37）: 関門はパッチ適用後の値を見る
      it("allows { evidence_required: false, status: 'done' } in a single patch (AC-36)", async () => {
        enableEnforcement(db);
        const app = createApp(db);
        const created = await createTask(app, true);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_required: false, status: "done" }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<Task>(res);
        expect(body.status).toBe("done");
        expect(body.evidence_required).toBe(false);
      });

      it("changing evidence_required: true -> false records a task_update note (AC-19)", async () => {
        const app = createApp(db);
        const created = await createTask(app, true);

        await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_required: false }),
        });

        const events = db
          .prepare("SELECT note FROM activity_events WHERE type = 'task_update'")
          .all() as { note: string | null }[];
        expect(events).toHaveLength(1);
        expect(events[0].note).not.toBeNull();
      });

      it("a patch that does not include evidence_required leaves the task_update note null (AC-20)", async () => {
        const app = createApp(db);
        const created = await createTask(app, false);

        await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "タイトルだけ" }),
        });

        const events = db
          .prepare("SELECT note FROM activity_events WHERE type = 'task_update'")
          .all() as { note: string | null }[];
        expect(events).toHaveLength(1);
        expect(events[0].note).toBeNull();
      });

      it("PATCH evidence_required from true to false updates the value (AC-17)", async () => {
        const app = createApp(db);
        const created = await createTask(app, true);

        const res = await app.request(`/api/tasks/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ evidence_required: false }),
        });

        expect(res.status).toBe(200);
        const body = await readJson<Task>(res);
        expect(body.evidence_required).toBe(false);
      });
    });
  });
});
