import type { AppEnv } from "../config.js";
import { MissingApiKeyError, type BossLlmClient } from "./claude-client.js";
import { registerLlmBackend, type LlmBackendImplementation } from "./llm-backend-registry.js";
import {
  createApiClient,
  streamApiMessage,
  createApiMessage,
  classifyApiError,
} from "./backends/api-backend.js";
import {
  streamClaudeCodeMessage,
  createClaudeCodeMessage,
  buildClaudeCodeEnv,
  checkClaudeCodeAvailability,
  nodeExecFileForAvailabilityCheck,
} from "./backends/claude-code-backend.js";

/** FR-13 / AC-12: re-exported so `server/src/index.ts`'s startup hook reaches
 * the `claude-code` backend through this Node-周辺 module rather than
 * importing `backends/claude-code-backend.js` directly — self-review
 * (design-reviewer, CONFIRMED): the direct import in `index.ts` reopened the
 * "one non-facade caller" gap a previous self-review had already closed
 * (back when `claude-client.ts` itself re-exported these). Since
 * `claude-client.ts` no longer imports any backend module (機能仕様
 * docs/features/tauri-in-app-runtime.md 実装計画①), this module —
 * `dev-llm-backends.ts`, the other Node-周辺 entry point into the `claude-code`
 * backend — is the appropriate place to keep that single-entry-point
 * convention alive for `index.ts`. */
export { checkClaudeCodeAvailability, nodeExecFileForAvailabilityCheck };

/**
 * 開発者用の版（現行の Node サーバー版）が使う2つの LLM バックエンド
 * （`api`・`claude-code`）を `llm/llm-backend-registry.ts` へ登録する
 * （機能仕様 docs/features/tauri-in-app-runtime.md クリティカル設計決定3・
 * 実装計画①）。このモジュール自身は `@anthropic-ai/claude-agent-sdk`・
 * `@anthropic-ai/sdk` を値として import する Node 周辺のモジュールであり、
 * 製品版のコアのエントリ（`core-entry.ts`）からは絶対に呼ばない —
 * 呼ぶのは開発者用の版の合成ルート（`app.ts` の `createApp`、必要なら
 * `index.ts`）だけ（オーナーの決定 Q4-b・Q4-c）。
 *
 * レジストリはモジュールレベルのグローバル状態なので、複数回呼んでも
 * 同じ実装で上書きするだけで安全（`Map#set` の冪等性）。
 */
export function registerDevLlmBackends(): void {
  const apiImplementation: LlmBackendImplementation = {
    // 機能仕様 docs/features/secure-transport-byok.md クリティカル設計決定5・
    // 受入基準（S2）「能力の宣言」: api はループを自分で回さず（ファサードの
    // 外側ループに従う）・toolChoice による強制に対応し・maxTokens で
    // 応答長を制限できる。
    capabilities: { runsOwnToolLoop: false, supportsToolChoice: true, limitsResponseLength: true },
    createClient(env: AppEnv): BossLlmClient {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new MissingApiKeyError();
      }
      return { backend: "api", client: createApiClient(apiKey) };
    },
    streamRound(client, request, hooks, signal) {
      if (client.backend !== "api") {
        throw new Error("api backend implementation received a non-api client");
      }
      return streamApiMessage(client.client, request, hooks.onTextDelta, signal);
    },
    createRound(client, request, signal) {
      if (client.backend !== "api") {
        throw new Error("api backend implementation received a non-api client");
      }
      return createApiMessage(client.client, request, signal);
    },
    classifyError: classifyApiError,
  };

  const claudeCodeImplementation: LlmBackendImplementation = {
    // claude-code は Agent SDK 自身の内部ツールループを回し（
    // runsOwnToolLoop: true）、toolChoice 相当の強制手段を持たず（プロンプト
    // の指示で代替）、要求ごとの応答長の制限手段も持たない（同様にプロンプト
    // の指示＋事後検証で代替する）。
    capabilities: { runsOwnToolLoop: true, supportsToolChoice: false, limitsResponseLength: false },
    createClient(env: AppEnv): BossLlmClient {
      return { backend: "claude-code", env: buildClaudeCodeEnv(env) };
    },
    streamRound(client, request, hooks, signal) {
      if (client.backend !== "claude-code") {
        throw new Error("claude-code backend implementation received a non-claude-code client");
      }
      return streamClaudeCodeMessage(
        { model: request.model, system: request.system, messages: request.messages, tools: request.tools },
        {
          onTextDelta: hooks.onTextDelta,
          onToolEvent: hooks.onToolEvent,
          executeTool: hooks.executeTool,
          signal,
          env: client.env,
        },
      );
    },
    createRound(client, request, signal) {
      if (client.backend !== "claude-code") {
        throw new Error("claude-code backend implementation received a non-claude-code client");
      }
      return createClaudeCodeMessage(
        { model: request.model, system: request.system, messages: request.messages, tools: request.tools },
        { signal, env: client.env },
      );
    },
  };

  registerLlmBackend("api", apiImplementation);
  registerLlmBackend("claude-code", claudeCodeImplementation);
}
