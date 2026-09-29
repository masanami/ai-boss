import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import type { AppEnv } from "../config.js";
import { createApp } from "../app.js";
import {
  registerLlmBackend,
  resetLlmBackendRegistryForTest,
  type LlmBackendCapabilities,
  type LlmBackendName,
  type ResolvedLlmRequest,
} from "./llm-backend-registry.js";
import type { BossLlmClient, BossLlmMessage } from "./claude-client.js";
import { resetLlmSelectionResolverForTest, setLlmSelectionResolver } from "./llm-selection.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertMessage } from "../sessions/messages-repository.js";
import { generateSessionSummary } from "../sessions/session-summary.js";
import { generateMeetingOpening } from "../sessions/meeting-opening.js";
import { extractEveningSummary } from "../reports/extract-evening-summary.js";
import { CLAUDE_CODE_SHORT_TEXT_INSTRUCTION, getOrGenerateBossComment } from "../dashboard/boss-comment.js";
import { generateNotificationBody } from "../notifications/notification-body.js";
import type { SecureTransportPort } from "./secure-transport-port.js";

/**
 * 受入基準（S3）S3-S7〜S3-S18・S3-S21・S3-S22（機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 7）: LLM を使う
 * 呼び出し元は、登録された選択の解決関数が返したバックエンドでクライアントを
 * 作り、返したモデルを要求に使う。
 *
 * 呼び出し元もファサードも模擬にせず、模擬のバックエンド（要求を記録する実装）を
 * レジストリへ登録し、`env` の `LLM_BACKEND` とは別の名前を返す模擬の解決関数で
 * 経路に乗せる（名前で `LLM_BACKEND` を読む実装だと、ここで別のバックエンドへ
 * 向かい、記録が空になる）。催促の予約の文面（S3-S19・S3-S20）は
 * `nudge-plan/replan-nudges.test.ts` で確かめる。
 */

const RESOLVED_MODEL = "model-from-the-resolver";
const noTransport: SecureTransportPort = async () => {
  throw new Error("the recording backend never sends");
};

interface Recording {
  createdWith: AppEnv[];
  requests: ResolvedLlmRequest[];
}

/** 名前 `name` の下に、要求を記録してテキストを返す模擬のバックエンドを登録する。 */
function registerRecordingBackend(
  name: LlmBackendName,
  capabilities: LlmBackendCapabilities,
  text = "了解した",
): Recording {
  const recording: Recording = { createdWith: [], requests: [] };
  const reply = (): BossLlmMessage => ({ content: [{ type: "text", text }] });
  registerLlmBackend(name, {
    capabilities,
    createClient(env) {
      recording.createdWith.push(env);
      // ファサードはクライアントの `backend` で実装を引くため、登録した名前を持たせる。
      return { backend: name, transport: noTransport, env } as unknown as BossLlmClient;
    },
    async streamRound(_client, request, hooks) {
      recording.requests.push(request);
      hooks.onTextDelta?.(text);
      return reply();
    },
    async createRound(_client, request) {
      recording.requests.push(request);
      return reply();
    },
  });
  return recording;
}

const PLAIN: LlmBackendCapabilities = {
  runsOwnToolLoop: false,
  supportsToolChoice: true,
  limitsResponseLength: true,
};

describe("選択の解決関数で決めたバックエンドとモデルを使う呼び出し元（#581 S3）", () => {
  let db: Database.Database;
  let recording: Recording;
  // `LLM_BACKEND` は `api` を指すが、解決関数は `byok-openai` を返す。
  const env: AppEnv = { LLM_BACKEND: "api" };

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
    recording = registerRecordingBackend("byok-openai", PLAIN);
    setLlmSelectionResolver(() => ({ backend: "byok-openai", model: RESOLVED_MODEL }));
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  async function chat(): Promise<void> {
    const app = createApp(portFor(db), env);
    const session = await insertSession(portFor(db), { type: "adhoc" });
    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    await res.text();
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

  async function comment(): Promise<void> {
    await getOrGenerateBossComment(portFor(db), env, new Date(2026, 8, 29, 10, 0));
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
    ["チャット（S3-S7・S3-S8）", chat],
    ["セッションの要約（S3-S9・S3-S10）", summarize],
    ["朝会の開始の発言（S3-S11・S3-S12）", openMeeting],
    ["夕会の要約抽出（S3-S13・S3-S14）", extractEvening],
    ["ダッシュボードのひとこと（S3-S15・S3-S16）", comment],
    ["通知文面（S3-S17・S3-S18）", notify],
  ];

  for (const [label, call] of callers) {
    it(`${label}: 解決関数が返した名前のバックエンドでクライアントを作る`, async () => {
      await call();
      expect(recording.createdWith).toHaveLength(1);
    });

    it(`${label}: 要求の model は解決関数が返したモデルである`, async () => {
      await call();
      expect(recording.requests.length).toBeGreaterThan(0);
      expect(recording.requests.map((request) => request.model)).toEqual(
        recording.requests.map(() => RESOLVED_MODEL),
      );
    });
  }
});

describe("能力の宣言は解決関数が返した名前のバックエンドから引く（#581 S3）", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
    resetLlmSelectionResolverForTest();
  });

  it("S3-S21: 夕会の要約抽出は、解決関数が返した `api`（強制に対応しない）の宣言に従い toolChoice を渡さない", async () => {
    // `claude-code`（`LLM_BACKEND` 未設定の既定）は「強制に対応する」と宣言しておく。
    // 名前を `LLM_BACKEND` から引く実装だとこちらへ向かい、toolChoice が付く。
    const decoy = registerRecordingBackend("claude-code", PLAIN);
    const api = registerRecordingBackend("api", { ...PLAIN, supportsToolChoice: false });
    setLlmSelectionResolver(() => ({ backend: "api", model: RESOLVED_MODEL }));
    const now = new Date(2026, 8, 29, 20, 0);

    await extractEveningSummary(
      portFor(db),
      {},
      [{ id: 1, session_id: 1, role: "user", content: "今日はタスクAを終えた", interrupted: 0, created_at: now.toISOString() }],
      [],
      now,
    );

    expect(decoy.requests).toEqual([]);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].toolChoice).toBeUndefined();
  });

  it("S3-S22: ダッシュボードのひとことは、解決関数が返した `claude-code`（応答長を制限できない）の宣言に従い短文の指示を足す", async () => {
    const decoy = registerRecordingBackend("api", PLAIN);
    const claudeCode = registerRecordingBackend("claude-code", { ...PLAIN, limitsResponseLength: false });
    setLlmSelectionResolver(() => ({ backend: "claude-code", model: RESOLVED_MODEL }));

    await getOrGenerateBossComment(portFor(db), { LLM_BACKEND: "api" }, new Date(2026, 8, 29, 10, 0));

    expect(decoy.requests).toEqual([]);
    expect(claudeCode.requests).toHaveLength(1);
    expect(JSON.stringify(claudeCode.requests[0].messages)).toContain(CLAUDE_CODE_SHORT_TEXT_INSTRUCTION);
  });
});
