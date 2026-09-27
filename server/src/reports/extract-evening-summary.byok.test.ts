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
import { BYOK_ANTHROPIC_BACKEND, registerByokAnthropicBackend } from "../llm/backends/byok-anthropic-backend.js";
import { extractEveningSummary } from "./extract-evening-summary.js";

/**
 * 受入基準（S2）「夕会の要約抽出を BYOK（Anthropic）で呼ぶと、要求本文の
 * `tool_choice` は `submit_evening_summary` の強制である」を、ファサードも
 * 呼び出し元も模擬にせず、実際の `extractEveningSummary` → `requestVerdict`
 * → BYOK（Anthropic）の実装 → 模擬の転送のポートの経路で固定する
 * （機能仕様 docs/features/secure-transport-byok.md）。
 *
 * 呼び出し元は S2 ではバックエンドを `LLM_BACKEND`（`api`・`claude-code`
 * のみ）で選ぶため、BYOK（Anthropic）の実装を名前 `api` の下にも登録して
 * 経路に乗せる（選択の経路は #582 S2 の範囲）。
 */

const now = new Date(2026, 7, 14, 20, 0);

const eveningMessages: Message[] = [
  { id: 1, session_id: 1, role: "user", content: "今日はタスクAを終わらせた", interrupted: 0, created_at: now.toISOString() },
];

function recordingTransport(): { transport: SecureTransportPort; requests: SecureTransportSendRequest[] } {
  const requests: SecureTransportSendRequest[] = [];
  const responseBody = JSON.stringify({
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "submit_evening_summary",
        input: {
          report_summary: "タスクAを完了した",
          boss_comment: "よくやった",
          key_decisions: "なし",
          carry_over: "なし",
        },
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

describe("extractEveningSummary — BYOK（Anthropic）の実装を通した経路", () => {
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

  it("夕会の要約抽出を BYOK（Anthropic）で呼ぶと、要求本文の tool_choice は submit_evening_summary の強制である", async () => {
    const { transport, requests } = recordingTransport();
    registerByokAnthropicBackend(transport);
    registerLlmBackend("api", getLlmBackendImplementation(BYOK_ANTHROPIC_BACKEND)!);

    await extractEveningSummary(portFor(db), { LLM_BACKEND: "api" }, eveningMessages, [], now);

    expect(requests).toHaveLength(1);
    expect(requests[0].destination).toBe("anthropic-messages");
    expect(JSON.parse(requests[0].body).tool_choice).toEqual({
      type: "tool",
      name: "submit_evening_summary",
    });
  });
});
