import Anthropic from "@anthropic-ai/sdk";
import type { BossContentBlock, BossLlmMessage, OnTextDelta } from "../claude-client.js";

/**
 * `api` backend: thin wrapper around the Claude API (`@anthropic-ai/sdk`),
 * moved out of `claude-client.ts` (Issue #78) so the facade can dispatch to
 * either this or the future `claude-code` backend behind a common contract.
 *
 * クリティカル設計決定（docs/adr/0002-api-key-and-llm-call-path.md）:
 * - API キーは呼び出し元（ファサード）が `process.env.ANTHROPIC_API_KEY` から
 *   読んで渡す（このモジュールは env を直接読まない）
 *
 * Issue #176: 呼び出し全体で共有されるタイムアウトと副作用後の再試行抑止と
 * いう統一ポリシーはファサード層（`claude-client.ts` の
 * `runWithTimeoutAndRetry`）の責務であり、この `api` バックエンドも
 * `claude-code` バックエンドと同様にそれへ従う（docs/adr/0003 帰結）。その
 * ため SDK 自身のリトライは `maxRetries: 0` で無効化する — 有効なまま
 * ファサード側のリトライで包むと二重にリトライがかかり最大 3 × 3 = 9 回
 * 試行になってしまう（トレードオフとして、SDK 自身のエラー種別判定・
 * `Retry-After` 尊重は失われファサードの一律リトライへ一本化される。
 * `claude-code` 側で Agent SDK 自身がリトライを行うかは本アプリのコードから
 * は制御・検証できないため、この一本化による相対的な非対称の有無は
 * 未確認——検証が必要になった場合は別途 Issue を切る、self-review:
 * design-reviewer）。`streamApiMessage` /
 * `createApiMessage` はファサードから渡された `AbortSignal` を SDK 呼び出し
 * のリクエストオプション（第2引数）へ転送し、ファサードが管理する共有の
 * タイムアウト予算に SDK 呼び出し自体を従わせる。SDK 自身の `timeout`
 * （`REQUEST_TIMEOUT_MS` = 120秒、`claude-client.ts` の
 * `DEFAULT_TIMEOUT_MS` と現状同値）は下位のバックストップとして残す —
 * 本番の唯一の呼び出し元（ファサード）は常に `signal` を渡すため、通常は
 * ファサードの `AbortController` が先に発火し SDK 側の `timeout` に到達する
 * ことはない。ファサード既定の `timeoutMs` を将来 120 秒より大きく変える
 * 場合は、この値もあわせて引き上げないと SDK 側がリクエスト単位の暗黙の
 * 上限として先に効いてしまう（「呼び出し全体で共有する」という設計と
 * 矛盾する）点に注意（self-review: code-reviewer/design-reviewer）。
 */

const REQUEST_TIMEOUT_MS = 120_000;
/** Issue #176: SDK 自身のリトライを無効化する（理由はこのファイル冒頭の doc
 * comment、および `claude-client.ts` の `runWithTimeoutAndRetry` の doc
 * comment を参照）。 */
const MAX_RETRIES = 0;

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
  /** Always resolved by the facade (`claude-client.ts`'s `resolveRequest`)
   * before reaching this module — see `ClaudeMessageRequest.thinking`'s doc
   * comment for the Issue #117 fail-safe-default rationale. */
  thinking: Anthropic.ThinkingConfigParam;
  outputConfig?: Anthropic.OutputConfig;
}

/**
 * Normalizes a raw `Anthropic.Message` into the facade's `BossLlmMessage`
 * contract (only `text`/`tool_use` blocks; everything else — including
 * `thinking` — carries no meaning for boss callers and is dropped).
 *
 * Issue #117: when the resulting `content` is empty, that is always an
 * anomaly (the turn produced nothing a caller can use — most commonly a
 * thinking-only response that hit `stop_reason: "max_tokens"` before any
 * text/tool_use was emitted). Logs a diagnostic in that case so the cause is
 * traceable from server logs alone. Deliberately restricted to metadata that
 * cannot leak conversation content: block *types* only (never `text`/
 * `thinking`/tool `input`/`output`), `stop_reason`, `model`, and token
 * counts from `usage` — never the system prompt or `messages` (see the
 * critical 外部システム連携 discipline this module's other call sites
 * already follow for error logging).
 */
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
  if (content.length === 0) {
    console.warn("api backend: normalized message has no text/tool_use content", {
      stopReason: message.stop_reason,
      blockTypes: message.content.map((block) => block.type),
      model: message.model,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
      thinkingTokens: message.usage?.output_tokens_details?.thinking_tokens,
    });
  }
  // `rawContent` keeps the assistant turn's original blocks (including
  // `thinking` and its signature) so the facade's tool loop can replay the
  // turn verbatim on the follow-up round — see `BossLlmMessage.rawContent`
  // in `claude-client.ts` for why the normalized `content` is unusable there.
  return { content, rawContent: message.content };
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
 *
 * `signal` (Issue #176) is the facade's shared `AbortSignal` for the whole
 * `runWithTimeoutAndRetry` call — forwarded to the SDK as the request
 * options' second argument so the in-flight HTTP request itself is aborted
 * once the facade's shared timeout budget elapses, not just the caller's
 * `await`. Only included in the `client.messages.stream(...)` call when
 * given (same "omit rather than pass `undefined`" convention as
 * `output_config` below) so call sites that don't manage a signal (e.g.
 * `api-backend.test.ts`'s direct-call tests) keep observing a single-
 * argument call.
 */
export function streamApiMessage(
  client: Anthropic,
  request: ApiMessageRequest,
  onTextDelta?: OnTextDelta,
  signal?: AbortSignal,
): Promise<BossLlmMessage> {
  const params = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    thinking: request.thinking,
    // Unlike `system`/`tools` (always forwarded, undefined or not),
    // `output_config` is only included when the caller actually set it — no
    // call site needs an explicit "use the API default" signal, so omitting
    // the key entirely when unset keeps the request minimal.
    ...(request.outputConfig !== undefined ? { output_config: request.outputConfig } : {}),
  };
  const stream = signal ? client.messages.stream(params, { signal }) : client.messages.stream(params);

  if (onTextDelta) {
    stream.on("text", onTextDelta);
  }

  return stream.finalMessage().then(normalizeMessage);
}

/**
 * Sends `request` to Claude and resolves with the full response
 * (normalized to `BossLlmMessage`) in one round-trip (no streaming).
 *
 * `signal` (Issue #176): see {@link streamApiMessage}'s doc comment — same
 * shared-`AbortSignal`-forwarding contract, only included in the
 * `client.messages.create(...)` call when given.
 */
export function createApiMessage(
  client: Anthropic,
  request: ApiMessageRequest,
  signal?: AbortSignal,
): Promise<BossLlmMessage> {
  const params = {
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
    thinking: request.thinking,
    ...(request.outputConfig !== undefined ? { output_config: request.outputConfig } : {}),
  };
  const result = signal ? client.messages.create(params, { signal }) : client.messages.create(params);
  return result.then(normalizeMessage);
}
