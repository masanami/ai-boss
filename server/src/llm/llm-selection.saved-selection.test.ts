import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { resetLlmBackendRegistryForTest } from "./llm-backend-registry.js";
import {
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  setLlmSelectionResolver,
} from "./llm-selection.js";
import {
  createRequestLog,
  registerRecordingBackend,
  type RequestLog,
} from "./test-support/recording-llm-backends.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertMessage } from "../sessions/messages-repository.js";
import { generateSessionSummary } from "../sessions/session-summary.js";
import {
  EVENING_OPENING_FALLBACK,
  MORNING_OPENING_FALLBACK,
  generateMeetingOpening,
} from "../sessions/meeting-opening.js";
import { extractEveningSummary } from "../reports/extract-evening-summary.js";
import { getOrGenerateBossComment } from "../dashboard/boss-comment.js";
import { buildFallbackBody, generateNotificationBody } from "../notifications/notification-body.js";

/**
 * 受入基準（S2）S2-R2〜S2-R6・S2-R11a〜S2-R11e（機能仕様
 * docs/features/llm-provider-abstraction.md）: 製品版の解決関数と、名前
 * `byok-anthropic`・`byok-openai` の記録するバックエンド 2 つを登録し、保存した
 * 選択（`settings` の `byok_provider`・`byok_model`）を差し替えると、次の
 * 要求の送信先とモデルが新しい選択に従う。チャット（S2-R1・R8〜R13）は
 * `sessions/chat-messages-route.selection.test.ts`、催促の予約の文面（S2-R7・
 * S2-R11f）は `nudge-plan/replan-nudges.selection.test.ts`。
 */

const FALLBACK_BOSS_COMMENT = "今日も決めたことを淡々とこなせ。";

describe("保存した選択が LLM の要求の送信先とモデルを決める（#582 S2）", () => {
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
    registerRecordingBackend("byok-anthropic", log);
    registerRecordingBackend("byok-openai", log);
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  function saveSelection(provider: string, model: string): void {
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

  // 呼び出しごとに日を進める——ダッシュボードのひとことは暦日ごとにキャッシュされ、
  // 同じ日の 2 回目はキャッシュから返って要求が出ないため。
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

  const callers: Array<[string, string, () => Promise<void>]> = [
    ["S2-R2", "セッションの要約", summarize],
    ["S2-R3", "会議の開始文", openMeeting],
    ["S2-R4", "ダッシュボードのひとこと", comment],
    ["S2-R5", "夕会の要約抽出", extractEvening],
    ["S2-R6", "通知文面", notify],
  ];

  for (const [id, label, call] of callers) {
    it(`${id}: 選択を anthropic・claude-sonnet-5 から openai・gpt-6-luna へ保存し直すと、次の${label}の要求は byok-openai へ gpt-6-luna で送られる`, async () => {
      saveSelection("anthropic", "claude-sonnet-5");
      await call();
      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests).toEqual(
        log.requests.map(() => ({ backend: "byok-anthropic", model: "claude-sonnet-5" })),
      );

      saveSelection("openai", "gpt-6-luna");
      log.requests.length = 0;
      await call();

      expect(log.requests.length).toBeGreaterThan(0);
      expect(log.requests).toEqual(log.requests.map(() => ({ backend: "byok-openai", model: "gpt-6-luna" })));
    });
  }

  describe("選択が未保存のとき", () => {
    function expectNothingSent(): void {
      expect(log.requests).toEqual([]);
      expect([...log.clientsCreated.entries()]).toEqual([]);
    }

    it("S2-R11a: 会議の開始文はテンプレートの文面になり、どちらの記録するバックエンドにも要求は送られない", async () => {
      const morning = await generateMeetingOpening(portFor(db), env, new Date(2026, 8, 29, 9, 0), "morning");
      const evening = await generateMeetingOpening(portFor(db), env, new Date(2026, 8, 29, 18, 0), "evening");

      expect(morning).toEqual({ text: MORNING_OPENING_FALLBACK, succeeded: false });
      expect(evening).toEqual({ text: EVENING_OPENING_FALLBACK, succeeded: false });
      expectNothingSent();
    });

    it("S2-R11b: ダッシュボードのひとことはテンプレートの文面になり、どちらの記録するバックエンドにも要求は送られない", async () => {
      const text = await getOrGenerateBossComment(portFor(db), env, new Date(2026, 8, 29, 10, 0));

      expect(text).toBe(FALLBACK_BOSS_COMMENT);
      expectNothingSent();
    });

    it("S2-R11c: 通知文面はテンプレートの文面になり、どちらの記録するバックエンドにも要求は送られない", async () => {
      const request = {
        ruleType: "silence" as const,
        escalationLevel: 1 as const,
        task: null,
        now: new Date(2026, 8, 29, 10, 0),
      };

      const body = await generateNotificationBody(portFor(db), env, request);

      expect(body).toBe(buildFallbackBody(request));
      expectNothingSent();
    });

    it("S2-R11d: セッションの要約は null になり、どちらの記録するバックエンドにも要求は送られない", async () => {
      const session = await insertSession(portFor(db), { type: "morning" });
      await insertMessage(portFor(db), { session_id: session.id, role: "user", content: "報告します" });

      const summary = await generateSessionSummary(portFor(db), env, session.id);

      expect(summary).toBeNull();
      expectNothingSent();
    });

    it("S2-R11e: 夕会の要約抽出は null になり、どちらの記録するバックエンドにも要求は送られない", async () => {
      const now = new Date(2026, 8, 29, 20, 0);

      const result = await extractEveningSummary(
        portFor(db),
        env,
        [{ id: 1, session_id: 1, role: "user", content: "今日はタスクAを終えた", interrupted: 0, created_at: now.toISOString() }],
        [],
        now,
      );

      expect(result).toBeNull();
      expectNothingSent();
    });
  });

  it("S2-R12: byok-anthropic だけを登録し、選択 openai・gpt-6-sol を保存すると、通知文面はテンプレートに退避し、byok-anthropic には何も送られない", async () => {
    resetLlmBackendRegistryForTest();
    registerRecordingBackend("byok-anthropic", log);
    saveSelection("openai", "gpt-6-sol");
    const request = {
      ruleType: "silence" as const,
      escalationLevel: 1 as const,
      task: null,
      now: new Date(2026, 8, 29, 10, 0),
    };

    const body = await generateNotificationBody(portFor(db), env, request);

    expect(body).toBe(buildFallbackBody(request));
    expect(log.requests).toEqual([]);
  });
});
