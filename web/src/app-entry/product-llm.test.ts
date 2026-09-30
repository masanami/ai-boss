// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { installProductLlm } from "./product-llm";
import { createTauriSecureTransport, type SecureEventChannel } from "./tauri-secure-transport";
import { registeredCoreLlmBackendNames, resolveLlmSelection } from "../../../server/src/core-entry.js";
import { LlmSelectionNotConfiguredError } from "../../../server/src/llm/llm-selection.js";
import { resetLlmBackendRegistryForTest } from "../../../server/src/llm/llm-backend-registry.js";
import { resetLlmSelectionResolverForTest } from "../../../server/src/llm/llm-selection.js";
import { createClaudeClient, streamBossMessage } from "../../../server/src/llm/claude-client.js";

/**
 * 製品版の LLM の準備（#581 S3・機能仕様 docs/features/secure-transport-byok.md
 * 受入基準（S3）S3-E1〜S3-E3 を、#582 S2 の受入基準（S2）S2-E1〜S2-E7
 * （docs/features/llm-provider-abstraction.md）が置き換えた）。
 */

afterEach(() => {
  resetLlmBackendRegistryForTest();
  resetLlmSelectionResolverForTest();
});

function fakeTransport() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const transport = createTauriSecureTransport({
    invoke: async (command, args) => {
      calls.push({ command, args });
      // キー未登録（再試行不可）で終わらせ、要求が器へ届いたことだけを確かめる。
      throw { kind: "key-not-registered" };
    },
    createChannel: (): SecureEventChannel => ({ onmessage: () => undefined }),
    newRequestId: () => crypto.randomUUID(),
  });
  return { transport, calls };
}

const anthropicSelection = new Map([
  ["byok_provider", "anthropic"],
  ["byok_model", "claude-sonnet-5"],
]);

function selectionOf(provider: string, model: string): Map<string, string> {
  return new Map([
    ["byok_provider", provider],
    ["byok_model", model],
  ]);
}

/** 解決関数で選択を解決し、そのバックエンドのクライアントで 1 回だけ streamBossMessage を呼ぶ。 */
async function streamWith(selection: Map<string, string>): Promise<void> {
  const { backend, model } = resolveLlmSelection({}, selection);
  await streamBossMessage(createClaudeClient({}, backend), {
    model,
    messages: [{ role: "user", content: "こんにちは" }],
  });
}

describe("installProductLlm", () => {
  // S3-E1〜S3-E3 の置き換え（#582 S2・S2-X1）: 登録は byok-anthropic だけ・未選択でも
  // byok-anthropic へ送る、から、両方を登録し保存した選択で送信先を決める、へ。
  it("S2-E1: 準備の後、登録済みの LLM バックエンドは byok-anthropic と byok-openai の 2 つだけである", () => {
    installProductLlm(fakeTransport().transport);
    expect([...registeredCoreLlmBackendNames()].sort()).toEqual(["byok-anthropic", "byok-openai"]);
  });

  it("S2-E2: 準備の後、選択 openai・gpt-6-sol で解決したクライアントの streamBossMessage は secure_send を宛先 openai-responses・要求本文の model gpt-6-sol で呼ぶ", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    await expect(streamWith(selectionOf("openai", "gpt-6-sol"))).rejects.toThrow();

    const sends = calls.filter((call) => call.command === "secure_send");
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]!.args.destination).toBe("openai-responses");
    expect(JSON.parse(String(sends[0]!.args.body)).model).toBe("gpt-6-sol");
  });

  it("S2-E3: 準備の後、選択 anthropic・claude-haiku-4-5 で同じことをすると、宛先 anthropic-messages・要求本文の model claude-haiku-4-5 で呼ばれる", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    await expect(streamWith(selectionOf("anthropic", "claude-haiku-4-5"))).rejects.toThrow();

    const sends = calls.filter((call) => call.command === "secure_send");
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]!.args.destination).toBe("anthropic-messages");
    expect(JSON.parse(String(sends[0]!.args.body)).model).toBe("claude-haiku-4-5");
  });

  it("S2-E4: 準備の後、選択が未保存のスナップショットで解決すると「未選択」の例外になり、invoke は呼ばれない", () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    expect(() => resolveLlmSelection({}, new Map())).toThrow(LlmSelectionNotConfiguredError);
    expect(calls).toEqual([]);
  });

  it("S2-E5: 選択 openai・gpt-6-sol で secure_send が key-not-registered で失敗すると streamBossMessage は失敗し、宛先 anthropic-messages の secure_send は呼ばれない", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    await expect(streamWith(selectionOf("openai", "gpt-6-sol"))).rejects.toThrow();

    const destinations = calls.filter((call) => call.command === "secure_send").map((call) => call.args.destination);
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations).not.toContain("anthropic-messages");
    expect(destinations).toEqual(destinations.map(() => "openai-responses"));
  });

  it("S2-E7: 選択 openai・gpt-6-astra（一覧に無い）で解決したクライアントの streamBossMessage は失敗し、secure_send の名前では invoke が呼ばれない", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    await expect(streamWith(selectionOf("openai", "gpt-6-astra"))).rejects.toThrow();

    expect(calls.filter((call) => call.command === "secure_send")).toEqual([]);
  });

  it("S2-E7: 選択 anthropic に他方のプロバイダのモデル（gpt-6-sol）を保存した状態でも失敗し、secure_send は呼ばれない", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);

    await expect(streamWith(selectionOf("anthropic", "gpt-6-sol"))).rejects.toThrow();

    expect(calls.filter((call) => call.command === "secure_send")).toEqual([]);
  });

  // PR #653 の指摘: BYOK（Anthropic）は 2xx 以外の応答の本文を読まずに失敗する。
  // 器の Tauri 実装の上でも、そのとき Rust の中継を止める（secure_cancel）。
  it("2xx 以外の応答で streamBossMessage が失敗すると、同じ requestId で secure_cancel が呼ばれる", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const transport = createTauriSecureTransport({
      invoke: async (command, args) => {
        calls.push({ command, args });
        // 401 は再試行不可（再試行の待ちが入らない）。
        return command === "secure_send" ? { status: 401, headers: {} } : true;
      },
      createChannel: (): SecureEventChannel => ({ onmessage: () => undefined }),
      newRequestId: () => "req-401",
    });
    installProductLlm(transport);
    const { backend, model } = resolveLlmSelection({}, anthropicSelection);

    await expect(
      streamBossMessage(createClaudeClient({}, backend), { model, messages: [{ role: "user", content: "こんにちは" }] }),
    ).rejects.toThrow();

    expect(calls.filter((call) => call.command === "secure_cancel").map((call) => call.args)).toEqual([
      { requestId: "req-401" },
    ]);
  });
});
