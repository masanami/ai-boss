import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper around the Claude API (`@anthropic-ai/sdk`) used for boss
 * dialogue (chat) and, in the future, notification copy generation.
 *
 * クリティカル設計決定（docs/features/ai-boss-mvp.md）:
 * - API キーは `process.env.ANTHROPIC_API_KEY`（server/.env 経由）からのみ読む
 * - リトライは指数バックオフで最大2回、タイムアウトはリクエスト単位120秒
 */

export const DEFAULT_MODEL = "claude-sonnet-5";

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const DEFAULT_MAX_TOKENS = 1024;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Configure it in server/.env before using the Claude client.",
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Creates a configured Anthropic client. The API key is read from `env`
 * (never accepted as a bare argument) so callers can't accidentally log it,
 * and is never included in the thrown error when missing.
 */
export function createClaudeClient(env: NodeJS.ProcessEnv): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  return new Anthropic({
    apiKey,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
}

export interface ClaudeMessageRequest {
  /** Defaults to {@link DEFAULT_MODEL}. Callers resolve this from settings. */
  model?: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** Forces (or disables) tool use. Only consumed by {@link createBossMessage}
   * so far — the chat route (`streamBossMessage`) has no need for it yet. */
  toolChoice?: Anthropic.ToolChoice;
  maxTokens?: number;
}

export type OnTextDelta = (textDelta: string) => void;

/**
 * Sends `request` to Claude and streams the response, relaying text deltas
 * to `onTextDelta` as they arrive. Resolves with the final Message once the
 * turn completes; `finalMessage.content` may include `tool_use` blocks for
 * the caller to execute and continue via {@link buildToolResultMessage}.
 */
export function streamBossMessage(
  client: Anthropic,
  request: ClaudeMessageRequest,
  onTextDelta?: OnTextDelta,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream({
    model: request.model ?? DEFAULT_MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });

  if (onTextDelta) {
    stream.on("text", onTextDelta);
  }

  return stream.finalMessage();
}

/**
 * Sends `request` to Claude and resolves with the full response in one
 * round-trip (no streaming). Used by the appeals re-adjudication flow
 * (Issue #48), which needs a single structured `submit_verdict` tool call
 * rather than a conversational stream — see the ticket's explicit
 * assumption ("再裁定は非ストリーミング").
 */
export function createBossMessage(
  client: Anthropic,
  request: ClaudeMessageRequest,
): Promise<Anthropic.Message> {
  return client.messages.create({
    model: request.model ?? DEFAULT_MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
  });
}

/**
 * Builds the follow-up user message that continues a conversation after a
 * tool has been executed locally, per the tool_use → tool_result protocol.
 * Pass the caller's `tool_use.id` as `toolUseId`.
 */
export function buildToolResultMessage(
  toolUseId: string,
  content: string,
  options: { isError?: boolean } = {},
): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        ...(options.isError ? { is_error: true } : {}),
      },
    ],
  };
}
