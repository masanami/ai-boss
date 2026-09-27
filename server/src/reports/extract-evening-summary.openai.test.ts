import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import type { Message } from "../sessions/message.js";
import {
  getLlmBackendImplementation,
  registerLlmBackend,
  resetLlmBackendRegistryForTest,
} from "../llm/llm-backend-registry.js";
import type { SecureTransportPort, SecureTransportSendRequest } from "../llm/secure-transport-port.js";
import { BYOK_OPENAI_BACKEND, OPENAI_RESPONSES_DESTINATION, registerByokOpenAiBackend } from "../llm/backends/byok-openai-backend.js";
import { setSettingValue } from "../settings/settings-repository.js";
import { extractEveningSummary } from "./extract-evening-summary.js";

/**
 * 受入基準（S1）「夕会の要約抽出を BYOK（OpenAI）のバックエンドで呼ぶと、
 * 要求本文の tool_choice は submit_evening_summary の強制である」を、
 * ファサードも呼び出し元も模擬にせず、実際の `extractEveningSummary` →
 * `requestVerdict` → BYOK（OpenAI）の実装 → 模擬の転送のポートの経路で
 * 固定する（機能仕様 docs/features/llm-provider-abstraction.md）。
 *
 * `extract-evening-summary.byok.test.ts`（#581 S2・BYOK（Anthropic））と同じ
 * 構造: 呼び出し元はバックエンドを `LLM_BACKEND`（`api`・`claude-code` のみ）
 * で選ぶため、BYOK（OpenAI）の実装を名前 `api` の下にも登録して経路に乗せる
 * （選択の経路は #582 S2 の範囲）。
 */

const now = new Date(2026, 8, 27, 20, 0);

const eveningMessages: Message[] = [
  { id: 1, session_id: 1, role: "user", content: "今日はタスクAを終わらせた", interrupted: 0, created_at: now.toISOString() },
];

function recordingTransport(): { transport: SecureTransportPort; requests: SecureTransportSendRequest[] } {
  const requests: SecureTransportSendRequest[] = [];
  const responseBody = JSON.stringify({
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "submit_evening_summary",
        arguments: JSON.stringify({
          report_summary: "タスクAを完了した",
          boss_comment: "よくやった",
          key_decisions: "なし",
          carry_over: "なし",
        }),
      },
    ],
  });
  const transport: SecureTransportPort = async (request) => {
    requests.push(request);
    return {
      status: 200,
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(responseBody);
        },
      },
    };
  };
  return { transport, requests };
}

describe("extractEveningSummary — BYOK（OpenAI）の実装を通した経路", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
    resetLlmBackendRegistryForTest();
  });

  afterEach(() => {
    db.close();
    resetLlmBackendRegistryForTest();
  });

  it("夕会の要約抽出を BYOK（OpenAI）で呼ぶと、要求本文の tool_choice は submit_evening_summary の強制である", async () => {
    const { transport, requests } = recordingTransport();
    registerByokOpenAiBackend(transport);
    registerLlmBackend("api", getLlmBackendImplementation(BYOK_OPENAI_BACKEND)!);
    // resolveBossSettings の既定モデル（DEFAULT_MODEL = "claude-sonnet-5"）は
    // Anthropic の一覧のモデルで OpenAI の一覧には無い——モデルの一覧の関門
    // （機能仕様クリティカル設計決定3）に拒否されないよう、OpenAI の一覧の
    // モデルを明示的に設定する。
    await setSettingValue(portFor(db), "model", "gpt-6-sol");

    await extractEveningSummary(portFor(db), { LLM_BACKEND: "api" }, eveningMessages, [], now);

    expect(requests).toHaveLength(1);
    expect(requests[0].destination).toBe(OPENAI_RESPONSES_DESTINATION);
    expect(JSON.parse(requests[0].body).tool_choice).toEqual({
      type: "function",
      name: "submit_evening_summary",
    });
  });
});
