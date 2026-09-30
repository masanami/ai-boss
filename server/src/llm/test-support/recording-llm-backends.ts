import {
  registerLlmBackend,
  type LlmBackendCapabilities,
  type LlmBackendName,
} from "../llm-backend-registry.js";
import type { BossLlmClient, BossLlmMessage } from "../claude-client.js";
import type { SecureTransportPort } from "../secure-transport-port.js";

/**
 * テスト専用の補助（機能仕様 docs/features/llm-provider-abstraction.md
 * 受入基準（S2）の冒頭「記録するバックエンド」）: `byok-anthropic`・
 * `byok-openai` などの名前で登録する、要求（バックエンドの名前とモデル）を
 * 記録して応答する模擬のバックエンド。1 つの {@link RequestLog} に複数の
 * バックエンドの要求を時系列で積むので、「どのバックエンドへ・どのモデルで
 * 送られたか」を 1 つの配列で照合できる。
 */

export interface LoggedRequest {
  backend: LlmBackendName;
  model: string;
}

export interface RequestLog {
  requests: LoggedRequest[];
  /** 各バックエンドの `createClient` が呼ばれた回数（名前 → 回数）。 */
  clientsCreated: Map<LlmBackendName, number>;
}

export function createRequestLog(): RequestLog {
  return { requests: [], clientsCreated: new Map() };
}

export const PLAIN_CAPABILITIES: LlmBackendCapabilities = {
  runsOwnToolLoop: false,
  supportsToolChoice: true,
  limitsResponseLength: true,
};

const noTransport: SecureTransportPort = async () => {
  throw new Error("the recording backend never sends");
};

/**
 * 名前 `name` の下に、要求を `log` へ記録してテキストを返す模擬のバックエンドを
 * 登録する。`onCreateClient` は `createClient` の中（クライアントを作る時点）で
 * 呼ばれる——割り込み（選択の保存）を差し込むために使う。
 */
export function registerRecordingBackend(
  name: LlmBackendName,
  log: RequestLog,
  options: { onCreateClient?: () => void; text?: string; capabilities?: LlmBackendCapabilities } = {},
): void {
  const text = options.text ?? "了解した";
  const reply = (): BossLlmMessage => ({ content: [{ type: "text", text }] });
  registerLlmBackend(name, {
    capabilities: options.capabilities ?? PLAIN_CAPABILITIES,
    createClient(env) {
      log.clientsCreated.set(name, (log.clientsCreated.get(name) ?? 0) + 1);
      options.onCreateClient?.();
      // ファサードはクライアントの `backend` で実装を引くため、登録した名前を持たせる。
      return { backend: name, transport: noTransport, env } as unknown as BossLlmClient;
    },
    async streamRound(_client, request, hooks) {
      log.requests.push({ backend: name, model: request.model });
      hooks.onTextDelta?.(text);
      return reply();
    },
    async createRound(_client, request) {
      log.requests.push({ backend: name, model: request.model });
      return reply();
    },
  });
}
