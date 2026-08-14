import Anthropic from "@anthropic-ai/sdk";
import type { BossContentBlock, BossLlmMessage, OnTextDelta } from "../claude-client.js";

/**
 * `api` backend: thin wrapper around the Claude API (`@anthropic-ai/sdk`),
 * moved out of `claude-client.ts` (Issue #78) so the facade can dispatch to
 * either this or the future `claude-code` backend behind a common contract.
 *
 * クリティカル設計決定（docs/features/ai-boss-mvp.md）:
 * - API キーは呼び出し元（ファサード）が `process.env.ANTHROPIC_API_KEY` から
 *   読んで渡す（このモジュールは env を直接読まない）
 * - リトライは指数バックオフで最大2回、タイムアウトはリクエスト単位120秒
 *   （SDK 自身のオプションとして委譲。変更しない）
 */

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

/** Constructs a configured Anthropic client for the given (already-resolved,
 * non-empty) API key. Callers (the facade) are responsible for the
 * `MissingApiKeyError` check — this module never sees the raw `env`. */
export function createApiClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

/**
 * A `ClaudeMessageRequest` with the facade's defaults (`DEFAULT_MODEL`,
 * `DEFAULT_MAX_TOKENS`) already resolved, so this module doesn't need to
 * import value bindings from `claude-client.ts` (avoids a runtime circular
 * dependency between the facade and this backend — only `import type`s are
 * shared, which are erased at compile time).
 */
export interface ApiMessageRequest {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  maxTokens: number;
}

function normalizeMessage(message: Anthropic.Message): BossLlmMessage {
  const content: BossContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // Other block types (e.g. thinking) carry no meaning for boss callers
    // and are intentionally dropped — see the ticket's normalization
    // contract (only text/tool_use are promised).
  }
  return { content };
}

/**
 * Sends `request` to Claude and streams the response, relaying text deltas
 * to `onTextDelta` as they arrive. Resolves with the final message
 * (normalized to `BossLlmMessage`) once the turn completes.
 *
 * `request.toolChoice` is intentionally not forwarded here (the SDK's
 * `messages.stream` call omits `tool_choice`) — this mirrors the facade's
 * pre-existing contract (`ClaudeMessageRequest.toolChoice`'s doc comment:
 * "Only consumed by `createBossMessage`"), which no `streamBossMessage`
 * caller has ever relied on. `createApiMessage` below is the one that
 * forwards it.
 */
export function streamApiMessage(
  client: Anthropic,
  request: ApiMessageRequest,
  onTextDelta?: OnTextDelta,
): Promise<BossLlmMessage> {
  const stream = client.messages.stream({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });

  if (onTextDelta) {
    stream.on("text", onTextDelta);
  }

  return stream.finalMessage().then(normalizeMessage);
}

/**
 * Sends `request` to Claude and resolves with the full response
 * (normalized to `BossLlmMessage`) in one round-trip (no streaming).
 */
export function createApiMessage(
  client: Anthropic,
  request: ApiMessageRequest,
): Promise<BossLlmMessage> {
  return client.messages
    .create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.toolChoice,
    })
    .then(normalizeMessage);
}
