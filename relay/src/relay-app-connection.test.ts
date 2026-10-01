import { describe, expect, it } from "vitest";
import { PLAN_DEFAULT_MODEL } from "./request-validation.js";
import {
  appRequestBody,
  createHarness,
  jsonResponse,
  messageJson,
  sseResponse,
  sseTranscript,
} from "./test-support/relay-harness.js";
// アプリ側（#583 S2）のバックエンドの要求本文が、中継の要求の検査を通ることを確かめるための
// テスト専用の依存（本体の `relay/src` は server を import しない）。
import {
  PLAN_DEFAULT_MODEL_ID,
  registerRelayBackend,
  RELAY_BACKEND,
} from "../../server/src/llm/backends/relay-backend.js";
import {
  getLlmBackendImplementation,
  resetLlmBackendRegistryForTest,
  type ResolvedLlmRequest,
} from "../../server/src/llm/llm-backend-registry.js";
import type { SecureTransportPort } from "../../server/src/llm/secure-transport-port.js";

/**
 * 受入基準（S2-B。機能仕様 docs/features/llm-relay-server.md）: アプリ側の `relay`
 * バックエンドが組む要求本文は、S1 の中継（既定のテスト設定）で拒否されずに模擬の上流へ
 * 転送される。アプリ → 中継の境界（転送のポート）は、要求をそのまま中継の `fetch` に渡す
 * 橋で模擬する。
 */

describe("アプリのプラン込みの既定の値と中継の既定のモデルの値", () => {
  it("TS の PLAN_DEFAULT_MODEL_ID は relay/ の PLAN_DEFAULT_MODEL と同じ値である", () => {
    expect(PLAN_DEFAULT_MODEL_ID).toBe(PLAN_DEFAULT_MODEL);
    expect(PLAN_DEFAULT_MODEL_ID).toBe("ai-boss-plan-default");
  });
});

function baseRequest(overrides: Partial<ResolvedLlmRequest> = {}): ResolvedLlmRequest {
  return {
    model: PLAN_DEFAULT_MODEL_ID,
    messages: [{ role: "user", content: "今日の進め方です" }],
    maxTokens: 1024,
    thinking: { type: "disabled" },
    ...overrides,
  };
}

const CASES: Array<[string, Partial<ResolvedLlmRequest>]> = [
  ["チャットの形（system・messages）", { system: "あなたはボスだ" }],
  [
    "ツールつき（tools・tool_choice）",
    {
      system: "あなたはボスだ",
      tools: [{ name: "create_task", description: "タスクを作る", input_schema: { type: "object", properties: {} } }],
      toolChoice: { type: "auto" },
    },
  ],
  [
    "ツールの強制と構造化出力の指定（tool_choice の tool・output_config）",
    {
      tools: [{ name: "submit", description: "d", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "submit" },
      outputConfig: { effort: "low" },
    },
  ],
  ["thinking の有効化", { thinking: { type: "enabled", budget_tokens: 2048 }, maxTokens: 4096 }],
];

describe.each([true, false])("relay の要求を S1 の中継へ通す（stream=%s）", (stream) => {
  for (const [label, overrides] of CASES) {
    it(`${label}は、要求の検査で拒否されずに模擬の上流へ転送され、応答が解釈できる`, async () => {
      resetLlmBackendRegistryForTest();
      const h = createHarness({
        upstream: () =>
          stream
            ? sseResponse(sseTranscript({ inputTokens: 5, outputTokens: [3], text: "決めた" }).join(""))
            : jsonResponse(messageJson({ input_tokens: 5, output_tokens: 3 }, "決めた")),
      });
      const destinations: string[] = [];
      const bridge: SecureTransportPort = async (request, signal) => {
        destinations.push(request.destination);
        const response = await h.send(request.body, { signal });
        return {
          status: response.status,
          headers: {},
          body: (async function* () {
            const text = await response.text();
            yield new TextEncoder().encode(text);
          })(),
        };
      };
      registerRelayBackend(bridge);
      const impl = getLlmBackendImplementation(RELAY_BACKEND)!;
      const client = impl.createClient({});
      const request = baseRequest(overrides);

      const message = stream
        ? await impl.streamRound(client, request, {}, new AbortController().signal)
        : await impl.createRound(client, request, new AbortController().signal);

      expect(destinations).toEqual(["relay-messages"]);
      expect(h.logs.filter((record) => record.event === "rejected")).toEqual([]);
      expect(h.calls).toHaveLength(1);
      // 上流へは既定のモデルの実 ID（claude-haiku-4-5）に書き換えて送られる。
      expect(h.calls[0].body.model).toBe("claude-haiku-4-5");
      expect(message.content).toEqual([{ type: "text", text: "決めた" }]);
    });
  }
});

describe("参考: 中継の検査はアプリの要求の最上位の項目の集合に一致する", () => {
  it("アプリが送る最上位の 9 項目はすべて中継の検査を通る（appRequestBody と同じ形）", async () => {
    const h = createHarness();
    const response = await h.send(
      appRequestBody({
        tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
      }),
    );
    expect(response.status).toBe(200);
  });
});
