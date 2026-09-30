import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { createApp } from "../app.js";
import { createCoreApp } from "../core-app.js";
import { MODEL_CATALOG } from "../llm/model-catalog.js";

/**
 * 受入基準（S2）S2-P1〜S2-P10（機能仕様 docs/features/llm-provider-abstraction.md
 * 「選択の保存（`/api/llm-selection`）」）。選択の入口は `createCoreApp` の
 * 引数で有効にしたときだけ振り向ける（製品版のエントリだけが有効にする）。
 */

interface SelectionBody {
  provider: string | null;
  model: string | null;
  modelInCatalog: boolean;
  catalog: Array<{ provider: string; modelId: string; displayName: string; isDefault: boolean }>;
}

describe("/api/llm-selection（#582 S2）", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createCoreApp>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    app = createCoreApp(portFor(db), {}, { llmSelectionApi: true });
  });

  afterEach(() => {
    db.close();
  });

  function put(body: unknown): Promise<Response> {
    return Promise.resolve(
      app.request("/api/llm-selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  async function get(): Promise<SelectionBody> {
    const res = await app.request("/api/llm-selection");
    expect(res.status).toBe(200);
    return (await res.json()) as SelectionBody;
  }

  function storedSelection(): Record<string, string | null> {
    const rows = db
      .prepare("SELECT key, value FROM settings WHERE key IN ('byok_provider', 'byok_model') ORDER BY key")
      .all() as Array<{ key: string; value: string | null }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  function saveDirectly(provider: string, model: string): void {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?), (?, ?)").run(
      "byok_provider",
      provider,
      "byok_model",
      model,
    );
  }

  async function saveViaApi(provider: string, model: string): Promise<void> {
    expect((await put({ provider, model })).status).toBe(200);
  }

  it("S2-P1: PUT で openai・gpt-6-luna を保存すると 200 を返し、その後の GET は同じ選択を返す", async () => {
    const res = await put({ provider: "openai", model: "gpt-6-luna" });

    expect(res.status).toBe(200);
    const putBody = (await res.json()) as SelectionBody;
    expect(putBody.provider).toBe("openai");
    expect(putBody.model).toBe("gpt-6-luna");
    expect(putBody.modelInCatalog).toBe(true);

    const body = await get();
    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-6-luna");
    expect(body.modelInCatalog).toBe(true);
  });

  it("S2-P1: 2 つのキー（byok_provider・byok_model）が settings に保存される", async () => {
    await saveViaApi("anthropic", "claude-haiku-4-5");

    expect(storedSelection()).toEqual({ byok_model: "claude-haiku-4-5", byok_provider: "anthropic" });
  });

  it("S2-P2: モデルが一覧に無い（gpt-6-astra）と 400（{ error } だけ）を返し、保存済みの選択は変わらない", async () => {
    await saveViaApi("anthropic", "claude-sonnet-5");

    const res = await put({ provider: "openai", model: "gpt-6-astra" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(typeof body.error).toBe("string");
    const after = await get();
    expect(after.provider).toBe("anthropic");
    expect(after.model).toBe("claude-sonnet-5");
    expect(storedSelection()).toEqual({ byok_model: "claude-sonnet-5", byok_provider: "anthropic" });
  });

  it("S2-P2: 未保存の状態で一覧に無いモデルを送っても何も保存されない", async () => {
    const res = await put({ provider: "openai", model: "gpt-6-astra" });

    expect(res.status).toBe(400);
    expect(storedSelection()).toEqual({});
  });

  it("S2-P3: 他方のプロバイダの一覧のモデル（openai に claude-sonnet-5）は 400 で、保存済みの選択は変わらない", async () => {
    await saveViaApi("anthropic", "claude-haiku-4-5");

    const res = await put({ provider: "openai", model: "claude-sonnet-5" });

    expect(res.status).toBe(400);
    expect(storedSelection()).toEqual({ byok_model: "claude-haiku-4-5", byok_provider: "anthropic" });
    const reverse = await put({ provider: "anthropic", model: "gpt-6-sol" });
    expect(reverse.status).toBe(400);
    expect(storedSelection()).toEqual({ byok_model: "claude-haiku-4-5", byok_provider: "anthropic" });
  });

  it("S2-P4: プロバイダが anthropic・openai 以外（google・空の文字列）だと 400 で、保存済みの選択は変わらない", async () => {
    await saveViaApi("openai", "gpt-6-sol");

    for (const provider of ["google", "", "OpenAI"]) {
      const res = await put({ provider, model: "gpt-6-sol" });
      expect(res.status).toBe(400);
    }
    expect(storedSelection()).toEqual({ byok_model: "gpt-6-sol", byok_provider: "openai" });
  });

  it("S2-P5: プロバイダだけ・モデルだけを送ると 400 で、保存済みの選択は変わらない", async () => {
    await saveViaApi("openai", "gpt-6-sol");

    expect((await put({ provider: "anthropic" })).status).toBe(400);
    expect((await put({ model: "claude-sonnet-5" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect(storedSelection()).toEqual({ byok_model: "gpt-6-sol", byok_provider: "openai" });
  });

  it("S2-P5: 文字列でない値・追加の項目・本文が JSON でない要求も 400 で、何も保存しない", async () => {
    expect((await put({ provider: 1, model: "gpt-6-sol" })).status).toBe(400);
    expect((await put({ provider: "openai", model: null })).status).toBe(400);
    expect((await put({ provider: "openai", model: "gpt-6-sol", model_extra: "x" })).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect((await put([])).status).toBe(400);
    expect(storedSelection()).toEqual({});
  });

  it("S2-P6: GET の catalog はモデルの一覧の 4 行（provider・modelId・displayName・isDefault）である", async () => {
    const body = await get();

    expect(body.catalog).toEqual(
      MODEL_CATALOG.map(({ provider, modelId, displayName, isDefault }) => ({
        provider,
        modelId,
        displayName,
        isDefault,
      })),
    );
    expect(body.catalog.map((row) => row.modelId)).toEqual([
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
  });

  it("S2-P7: 保存したモデルがそのプロバイダの一覧に無い（DB に直接 openai・gpt-6-astra）と、GET の model は gpt-6-astra のまま", async () => {
    saveDirectly("openai", "gpt-6-astra");

    const body = await get();

    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-6-astra");
  });

  it("S2-P7b: 一覧に無いモデルを保存した状態では modelInCatalog が false、一覧のモデルでは true", async () => {
    saveDirectly("openai", "gpt-6-astra");
    expect((await get()).modelInCatalog).toBe(false);

    await saveViaApi("openai", "gpt-6-sol");
    expect((await get()).modelInCatalog).toBe(true);
  });

  it("S2-P7b: 他方のプロバイダの一覧のモデルを DB に直接保存した状態でも modelInCatalog は false", async () => {
    saveDirectly("openai", "claude-sonnet-5");

    expect((await get()).modelInCatalog).toBe(false);
  });

  it("S2-P7c: 選択が未保存のとき provider と model は null（modelInCatalog は false）", async () => {
    const body = await get();

    expect(body.provider).toBeNull();
    expect(body.model).toBeNull();
    expect(body.modelInCatalog).toBe(false);
  });

  it("S2-P7c: 保存値のプロバイダが 2 値以外のときも provider は null（未選択）として返す", async () => {
    saveDirectly("google", "gemini-x");

    const body = await get();

    expect(body.provider).toBeNull();
    expect(body.modelInCatalog).toBe(false);
  });

  it("S2-P7c: プロバイダだけが保存されていてモデルが無いとき model は null で modelInCatalog は false", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('byok_provider', 'openai')").run();

    const body = await get();

    expect(body.provider).toBe("openai");
    expect(body.model).toBeNull();
    expect(body.modelInCatalog).toBe(false);
  });

  it("S2-P7c: 保存値のモデルが空の文字列のときも model は null（解決関数と同じく未選択の扱い）", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('byok_provider', 'openai'), ('byok_model', '')").run();

    const body = await get();

    expect(body.provider).toBe("openai");
    expect(body.model).toBeNull();
    expect(body.modelInCatalog).toBe(false);
  });

  it("S2-P9: PUT /api/settings に byok_provider または byok_model を含めると 400 で、何も保存しない", async () => {
    for (const patch of [
      { byok_provider: "openai" },
      { byok_model: "gpt-6-sol" },
      { boss_name: "新ボス", byok_provider: "openai", byok_model: "gpt-6-sol" },
    ]) {
      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
    }
    expect(storedSelection()).toEqual({});
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });
});

describe("選択の入口を有効にしないアプリ（#582 S2）", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(() => {
    db.close();
  });

  it("S2-P8: 開発者用の版のアプリ（createApp）では GET /api/llm-selection は 404 である", async () => {
    const app = createApp(portFor(db), {});

    expect((await app.request("/api/llm-selection")).status).toBe(404);
    expect(
      (
        await app.request("/api/llm-selection", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "openai", model: "gpt-6-sol" }),
        })
      ).status,
    ).toBe(404);
  });

  it("S2-P8: 選択の入口を有効にしない createCoreApp でも GET /api/llm-selection は 404 である", async () => {
    const app = createCoreApp(portFor(db), {});

    expect((await app.request("/api/llm-selection")).status).toBe(404);
  });

  it("S2-P10: 開発者用の版の GET /api/settings の応答のキーの集合は S2 の前と同じ（byok_* を含まない）", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('byok_provider', 'openai'), ('byok_model', 'gpt-6-sol')").run();
    const app = createApp(portFor(db), {});

    const res = await app.request("/api/settings");
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        "boss_name",
        "boss_tone_preset",
        "boss_strictness",
        "boss_custom_instructions",
        "work_start",
        "work_end",
        "morning_meeting_time",
        "evening_meeting_time",
        "detection_unstarted_fallback_minutes",
        "detection_silence_fallback_minutes",
        "detection_break_fallback_minutes",
        "escalation_l2_after_minutes",
        "escalation_l3_after_minutes",
        "escalation_repeat_minutes",
        "detection_daily_notification_cap",
        "model",
        "evidence_enforcement_enabled",
        "morning_mentoring_required",
      ].sort(),
    );
  });
});
