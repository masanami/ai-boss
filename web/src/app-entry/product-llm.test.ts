// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { installProductLlm } from "./product-llm";
import { createTauriSecureTransport, type SecureEventChannel } from "./tauri-secure-transport";
import { registeredCoreLlmBackendNames, resolveLlmSelection } from "../../../server/src/core-entry.js";
import { resetLlmBackendRegistryForTest } from "../../../server/src/llm/llm-backend-registry.js";
import { resetLlmSelectionResolverForTest } from "../../../server/src/llm/llm-selection.js";
import { createClaudeClient, streamBossMessage } from "../../../server/src/llm/claude-client.js";

/**
 * 製品版の LLM の準備（#581 S3・機能仕様 docs/features/secure-transport-byok.md
 * 受入基準（S3）S3-E1〜S3-E3）。
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

describe("installProductLlm", () => {
  it("S3-E1: 準備の後、登録済みの LLM バックエンドは byok-anthropic だけである", () => {
    installProductLlm(fakeTransport().transport);
    expect(registeredCoreLlmBackendNames()).toEqual(["byok-anthropic"]);
  });

  it("S3-E2: 準備の後、LLM_BACKEND の無い env で解決するとバックエンドは byok-anthropic である", () => {
    installProductLlm(fakeTransport().transport);
    expect(resolveLlmSelection({}, new Map()).backend).toBe("byok-anthropic");
  });

  it("S3-E3: 準備の後、解決したバックエンドで streamBossMessage を呼ぶと secure_send が宛先 anthropic-messages で呼ばれる", async () => {
    const { transport, calls } = fakeTransport();
    installProductLlm(transport);
    const { backend, model } = resolveLlmSelection({}, new Map());
    const client = createClaudeClient({}, backend);

    await expect(
      streamBossMessage(client, { model, messages: [{ role: "user", content: "こんにちは" }] }),
    ).rejects.toThrow();

    const sends = calls.filter((call) => call.command === "secure_send");
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]!.args.destination).toBe("anthropic-messages");
    expect(JSON.parse(String(sends[0]!.args.body)).model).toBe("claude-sonnet-5");
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
    const { backend, model } = resolveLlmSelection({}, new Map());

    await expect(
      streamBossMessage(createClaudeClient({}, backend), { model, messages: [{ role: "user", content: "こんにちは" }] }),
    ).rejects.toThrow();

    expect(calls.filter((call) => call.command === "secure_cancel").map((call) => call.args)).toEqual([
      { requestId: "req-401" },
    ]);
  });
});
