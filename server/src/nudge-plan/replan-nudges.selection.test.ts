import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../db/test-support/create-test-db.js";
import type { DbPort } from "../db/db-port.js";
import { resetLlmBackendRegistryForTest } from "../llm/llm-backend-registry.js";
import {
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  setLlmSelectionResolver,
} from "../llm/llm-selection.js";
import {
  createRequestLog,
  registerRecordingBackend,
  type RequestLog,
} from "../llm/test-support/recording-llm-backends.js";
import { createNudgeReplanner } from "./replan-nudges.js";
import {
  createFakeSchedulerPort,
  insertActivityRow,
  insertSessionRow,
  insertTaskRow,
  reservationRows,
  type FakeSchedulerPort,
} from "./replan-test-fixtures.js";

/**
 * 受入基準（S2）S2-R7・S2-R11f（機能仕様 docs/features/llm-provider-abstraction.md）:
 * 催促の予約の文面（B〔個別の文面〕・C〔文面セット〕）も、保存した選択が要求の
 * 送信先とモデルを決める。製品版の解決関数と、名前 `byok-anthropic`・`byok-openai`
 * の記録するバックエンドを登録して行う（クライアントの作成・ファサードは模擬に
 * しない）。
 */

const NOW = new Date(2026, 8, 14, 10, 0); // 月曜 10:00（ローカル）

interface Harness {
  db: DbPort;
  raw: Database.Database;
  port: FakeSchedulerPort;
}

/** 基本の状況（`replan-nudges.test.ts` の `setup` と同じ）: 未着手の最優先タスク 1 件。 */
async function setup(): Promise<Harness> {
  const { db, raw } = await createTestDb();
  insertSessionRow(raw, "morning", new Date(2026, 8, 14, 9, 0));
  insertSessionRow(raw, "evening", new Date(2026, 8, 14, 9, 1));
  insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 9, 55));
  insertTaskRow(raw, { created_at: new Date(2026, 8, 14, 9, 0).toISOString() });
  return { db, raw, port: createFakeSchedulerPort(true) };
}

describe("催促の予約の文面の送信先は保存した選択で決まる（#582 S2）", () => {
  let log: RequestLog;
  let opened: Database.Database | undefined;

  beforeEach(() => {
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    setLlmSelectionResolver(productLlmSelectionResolver);
    log = createRequestLog();
    registerRecordingBackend("byok-anthropic", log);
    registerRecordingBackend("byok-openai", log);
    registerRecordingBackend("relay", log);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    opened?.close();
    opened = undefined;
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    vi.restoreAllMocks();
  });

  function saveSelection(raw: Database.Database, provider: string, model: string): void {
    raw
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('byok_provider', ?), ('byok_model', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(provider, model);
  }

  async function setupHarness(): Promise<Harness> {
    const h = await setup();
    opened = h.raw;
    return h;
  }

  async function replan(h: Harness): Promise<void> {
    const replanner = createNudgeReplanner({ db: h.db, env: {}, port: h.port, clock: () => NOW });
    await replanner.requestReplan();
    await replanner.whenIdle();
  }

  it("S2-R7: 選択を anthropic・claude-sonnet-5 から openai・gpt-6-luna へ保存し直すと、次の催促の予約の文面の要求は byok-openai へ gpt-6-luna で送られる", async () => {
    const h = await setupHarness();
    saveSelection(h.raw, "anthropic", "claude-sonnet-5");
    await replan(h);
    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests).toEqual(
      log.requests.map(() => ({ backend: "byok-anthropic", model: "claude-sonnet-5" })),
    );

    // 生成済みの文面の控えを消し、次の計画し直しで文面を作り直させる。
    h.raw.exec("DELETE FROM nudge_reservations; DELETE FROM nudge_individual_bodies; DELETE FROM nudge_message_sets; DELETE FROM nudge_generation_attempts;");
    saveSelection(h.raw, "openai", "gpt-6-luna");
    log.requests.length = 0;
    await replan(h);

    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests).toEqual(log.requests.map(() => ({ backend: "byok-openai", model: "gpt-6-luna" })));
  });

  it("llm_billing_route=plan を保存すると、次の催促の予約の文面の要求は relay へプラン込みの既定の値で送られる（BYOK の選択が保存済みでも。#583 S2）", async () => {
    const h = await setupHarness();
    saveSelection(h.raw, "anthropic", "claude-sonnet-5");
    await replan(h);
    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests).toEqual(
      log.requests.map(() => ({ backend: "byok-anthropic", model: "claude-sonnet-5" })),
    );

    h.raw.exec("DELETE FROM nudge_reservations; DELETE FROM nudge_individual_bodies; DELETE FROM nudge_message_sets; DELETE FROM nudge_generation_attempts;");
    h.raw.exec("INSERT INTO settings (key, value) VALUES ('llm_billing_route', 'plan')");
    log.requests.length = 0;
    await replan(h);

    expect(log.requests.length).toBeGreaterThan(0);
    expect(log.requests).toEqual(log.requests.map(() => ({ backend: "relay", model: "ai-boss-plan-default" })));
  });

  it("S2-R11f: 選択が未保存のとき、催促の予約の計画し直しは予約を作り（LLM の文面を持たない既存の退避の形）、どちらの記録するバックエンドにも要求は送られない", async () => {
    const h = await setupHarness();

    await replan(h);

    expect(h.port.scheduled.size).toBeGreaterThan(0);
    const rows = reservationRows(h.raw);
    expect(rows.length).toBeGreaterThan(0);
    // 文面の出どころは固定文（fallback）か報告の促しの固定文（report_prompt）だけで、
    // LLM 由来（individual・message_set）は 1 件も無い。
    expect(rows.filter((row) => row.body_source === "individual" || row.body_source === "message_set")).toEqual([]);
    expect(rows.some((row) => row.body_source === "fallback")).toBe(true);
    expect(log.requests).toEqual([]);
    expect([...log.clientsCreated.entries()]).toEqual([]);
  });
});
