import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { resetLlmBackendRegistryForTest } from "./llm-backend-registry.js";
import {
  LLM_BILLING_ROUTE_SETTING_KEY,
  LlmSelectionNotConfiguredError,
  devLlmSelectionResolver,
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  resolveLlmSelection,
  setLlmSelectionResolver,
} from "./llm-selection.js";
import {
  createRequestLog,
  registerRecordingBackend,
  type RequestLog,
} from "./test-support/recording-llm-backends.js";
import { registerRelayBackend } from "./backends/relay-backend.js";
import type { SecureTransportPort } from "./secure-transport-port.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertMessage } from "../sessions/messages-repository.js";
import { generateSessionSummary } from "../sessions/session-summary.js";
import {
  MORNING_OPENING_FALLBACK,
  generateMeetingOpening,
} from "../sessions/meeting-opening.js";
import { extractEveningSummary } from "../reports/extract-evening-summary.js";
import { getOrGenerateBossComment } from "../dashboard/boss-comment.js";
import { buildFallbackBody, generateNotificationBody } from "../notifications/notification-body.js";
import { createCoreApp } from "../core-app.js";

/**
 * 受入基準（S2-S。機能仕様 docs/features/llm-relay-server.md）: 課金経路の選択
 * （`llm_billing_route`）が LLM の要求の送信先を決める。チャットは
 * `sessions/chat-messages-route.selection.test.ts`、催促の予約の文面は
 * `nudge-plan/replan-nudges.selection.test.ts`。
 */

describe("製品版の解決関数と課金経路の選択（S2-S）", () => {
  const route = (value: string | undefined, extra: Array<[string, string]> = []) => {
    const map = new Map<string, string>(extra);
    if (value !== undefined) map.set(LLM_BILLING_ROUTE_SETTING_KEY, value);
    return map;
  };
  const byokSaved: Array<[string, string]> = [
    ["byok_provider", "anthropic"],
    ["byok_model", "claude-haiku-4-5"],
  ];

  it("設定のキーは llm_billing_route", () => {
    expect(LLM_BILLING_ROUTE_SETTING_KEY).toBe("llm_billing_route");
  });

  it("plan なら relay とプラン込みの既定の値を返す（byok_provider・byok_model が保存済みでも未保存でも）", () => {
    const expected = { backend: "relay", model: "ai-boss-plan-default" };
    expect(productLlmSelectionResolver({}, route("plan", byokSaved))).toEqual(expected);
    expect(productLlmSelectionResolver({}, route("plan"))).toEqual(expected);
  });

  it("plan のとき byok_provider・byok_model は読まない（不正な値が保存されていても失敗しない）", () => {
    const reads: string[] = [];
    const settings: ReadonlyMap<string, string> = new (class extends Map<string, string> {
      override get(key: string): string | undefined {
        reads.push(key);
        return super.get(key);
      }
    })([
      [LLM_BILLING_ROUTE_SETTING_KEY, "plan"],
      ["byok_provider", "bogus"],
    ]);
    expect(productLlmSelectionResolver({}, settings)).toEqual({ backend: "relay", model: "ai-boss-plan-default" });
    expect(reads).toEqual([LLM_BILLING_ROUTE_SETTING_KEY]);
  });

  it("byok または無いときは、#582 S2 の解決と同じ結果（byok-anthropic／byok-openai、未選択なら未選択の例外）", () => {
    for (const value of ["byok", undefined]) {
      expect(productLlmSelectionResolver({}, route(value, byokSaved))).toEqual({
        backend: "byok-anthropic",
        model: "claude-haiku-4-5",
      });
      expect(
        productLlmSelectionResolver({}, route(value, [["byok_provider", "openai"], ["byok_model", "gpt-6-luna"]])),
      ).toEqual({ backend: "byok-openai", model: "gpt-6-luna" });
      expect(() => productLlmSelectionResolver({}, route(value))).toThrow(LlmSelectionNotConfiguredError);
    }
  });

  it("plan・byok 以外の値（空の文字列・PLAN・relay・前後の空白）は、BYOK の選択が保存済みでも未選択の例外を投げる", () => {
    for (const value of ["", "PLAN", "relay", " plan", "plan ", "Byok", "byok-anthropic"]) {
      expect(() => productLlmSelectionResolver({}, route(value, byokSaved)), JSON.stringify(value)).toThrow(
        LlmSelectionNotConfiguredError,
      );
    }
  });

  it("開発者用の解決関数は llm_billing_route を読まない（plan でも LLM_BACKEND と設定の model に従う）", () => {
    const settings = route("plan", [["model", "claude-haiku-4-5"]]);
    expect(devLlmSelectionResolver({ LLM_BACKEND: "api" }, settings)).toEqual({
      backend: "api",
      model: "claude-haiku-4-5",
    });
    expect(devLlmSelectionResolver({}, settings).backend).toBe("claude-code");
  });
});

describe("保存した課金経路が LLM の要求の送信先を決める（S2-S）", () => {
  let db: Database.Database;
  let log: RequestLog;
  const env = {};

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    setLlmSelectionResolver(productLlmSelectionResolver);
    log = createRequestLog();
    registerRecordingBackend("relay", log);
    registerRecordingBackend("byok-anthropic", log);
    registerRecordingBackend("byok-openai", log);
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  function saveRoute(value: string): void {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('llm_billing_route', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(value);
  }

  function saveByok(provider: string, model: string): void {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('byok_provider', ?), ('byok_model', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(provider, model);
  }

  async function summarize(): Promise<void> {
    const session = await insertSession(portFor(db), { type: "morning" });
    await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });
    await generateSessionSummary(portFor(db), env, session.id);
  }

  async function openMeeting(): Promise<void> {
    await generateMeetingOpening(portFor(db), env, new Date(2026, 8, 29, 9, 0), "morning");
  }

  async function extractEvening(): Promise<void> {
    const now = new Date(2026, 8, 29, 20, 0);
    await extractEveningSummary(
      portFor(db),
      env,
      [{ id: 1, session_id: 1, role: "user", content: "今日はタスクAを終えた", interrupted: 0, created_at: now.toISOString() }],
      [],
      now,
    );
  }

  // 呼び出しごとに日を進める（ひとことは暦日ごとにキャッシュされるため）。
  let commentDay = 0;
  async function comment(): Promise<void> {
    commentDay += 1;
    await getOrGenerateBossComment(portFor(db), env, new Date(2026, 8, commentDay, 10, 0));
  }

  async function notify(): Promise<void> {
    await generateNotificationBody(portFor(db), env, {
      ruleType: "silence",
      escalationLevel: 1,
      task: null,
      now: new Date(2026, 8, 29, 10, 0),
    });
  }

  const callers: Array<[string, () => Promise<void>]> = [
    ["セッションの要約", summarize],
    ["会議の開始文", openMeeting],
    ["ダッシュボードのひとこと", comment],
    ["夕会の要約抽出", extractEvening],
    ["通知文面", notify],
  ];

  for (const [label, call] of callers) {
    it(`llm_billing_route=plan を保存すると、アプリを作り直さずに次の${label}の要求は relay へプラン込みの既定の値で送られる（BYOK の選択が保存済みでも）`, async () => {
      saveByok("anthropic", "claude-sonnet-5");
      await call();
      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests).toEqual(
        log.requests.map(() => ({ backend: "byok-anthropic", model: "claude-sonnet-5" })),
      );

      saveRoute("plan");
      log.requests.length = 0;
      await call();

      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests).toEqual(log.requests.map(() => ({ backend: "relay", model: "ai-boss-plan-default" })));
    });

    it(`llm_billing_route を byok に戻すと、次の${label}の要求は BYOK へ戻る`, async () => {
      saveByok("openai", "gpt-6-luna");
      saveRoute("plan");
      await call();
      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests.every((r) => r.backend === "relay")).toBe(true);

      saveRoute("byok");
      log.requests.length = 0;
      await call();
      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests).toEqual(log.requests.map(() => ({ backend: "byok-openai", model: "gpt-6-luna" })));
    });
  }

  it("plan・byok 以外の値を保存すると、どのバックエンドへも送られない（会議の開始文はテンプレートへ退避する）", async () => {
    saveByok("anthropic", "claude-sonnet-5");
    saveRoute("PLAN");
    const result = await generateMeetingOpening(portFor(db), env, new Date(2026, 8, 29, 9, 0), "morning");
    expect(result).toEqual({ text: MORNING_OPENING_FALLBACK, succeeded: false });
    expect(log.requests).toEqual([]);
    expect([...log.clientsCreated.entries()]).toEqual([]);
  });
});

describe("開発者用の版（解決関数を登録しない）は llm_billing_route に影響されない（S2-S）", () => {
  let db: Database.Database;
  let log: RequestLog;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    log = createRequestLog();
    registerRecordingBackend("claude-code", log);
    registerRecordingBackend("api", log);
    registerRecordingBackend("relay", log);
    db.prepare("INSERT INTO settings (key, value) VALUES ('llm_billing_route', 'plan')").run();
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  async function chat(env: Record<string, string>): Promise<void> {
    const app = createCoreApp(portFor(db), env);
    const session = await insertSession(portFor(db), { type: "adhoc" });
    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }

  it("LLM_BACKEND 未設定のとき、チャットの要求は claude-code へ送られる", async () => {
    await chat({});
    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests.every((r) => r.backend === "claude-code")).toBe(true);
    expect(resolveLlmSelection({}, new Map([["llm_billing_route", "plan"]])).backend).toBe("claude-code");
  });

  it("LLM_BACKEND=api のとき、チャットの要求は api へ送られる", async () => {
    await chat({ LLM_BACKEND: "api" });
    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests.every((r) => r.backend === "api")).toBe(true);
  });
});

describe("relay が上限到達で失敗したとき、チャット以外はテンプレートの文面になる（S2-G）", () => {
  let db: Database.Database;
  const env = {};
  let sent: string[];

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    setLlmSelectionResolver(productLlmSelectionResolver);
    sent = [];
    const limited: SecureTransportPort = async (request) => {
      sent.push(request.destination);
      const body = JSON.stringify({
        type: "error",
        error: { type: "usage_limit_exceeded", limit: "daily", message: "BODY-MARKER" },
      });
      return {
        status: 429,
        headers: {},
        body: (async function* () {
          yield new TextEncoder().encode(body);
        })(),
      };
    };
    registerRelayBackend(limited);
    registerRecordingBackend("byok-anthropic", createRequestLog());
    db.prepare("INSERT INTO settings (key, value) VALUES ('llm_billing_route', 'plan')").run();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    vi.restoreAllMocks();
  });

  it("ダッシュボードのひとことはテンプレートの文面になる", async () => {
    const text = await getOrGenerateBossComment(portFor(db), env, new Date(2026, 8, 29, 10, 0));
    expect(text).toBe("今日も決めたことを淡々とこなせ。");
    expect(sent).toEqual(["relay-messages"]);
  });

  it("通知文面はテンプレートの文面になる", async () => {
    const request = {
      ruleType: "silence" as const,
      escalationLevel: 1 as const,
      task: null,
      now: new Date(2026, 8, 29, 10, 0),
    };
    const body = await generateNotificationBody(portFor(db), env, request);
    expect(body).toBe(buildFallbackBody(request));
    expect(sent).toEqual(["relay-messages"]);
  });

  it("会議の開始文はテンプレートの文面になる", async () => {
    const result = await generateMeetingOpening(portFor(db), env, new Date(2026, 8, 29, 9, 0), "morning");
    expect(result).toEqual({ text: MORNING_OPENING_FALLBACK, succeeded: false });
    expect(sent).toEqual(["relay-messages"]);
  });
});

describe("課金経路は画面・設定の API から変えられない（決定 S2-Q7。#584 まで）", () => {
  it("PUT /api/settings に llm_billing_route を送ると 400 で拒否され、何も保存されない", async () => {
    const db = openDatabase(":memory:");
    try {
      await runMigrations(portFor(db));
      const app = createCoreApp(portFor(db), {});
      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_billing_route: "plan" }),
      });
      expect(res.status).toBe(400);
      expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'llm_billing_route'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
