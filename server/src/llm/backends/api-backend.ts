import Anthropic, { APIError } from "@anthropic-ai/sdk";
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
 * 試行になってしまう。当初（Issue #176）はこれにより SDK 自身のエラー種別
 * 判定・`Retry-After` 尊重が失われファサードの一律リトライへ後退する
 * トレードオフを受け入れていたが、Issue #223（この下の `isRetryableApiError`
 * / `getApiRetryAfterMs`）と #224（`claude-client.ts` の
 * `RetryTimeoutOptions.classifyError` 経由でこの2関数を `api` 分岐にのみ接続）
 * でその判定・待機を二重リトライを再導入せずに回復した——ただし
 * `claude-code` 側で Agent SDK 自身がリトライを行うかは本アプリのコードから
 * は制御・検証できないため、両経路間の相対的な非対称の有無は未確認——
 * 検証が必要になった場合は別途 Issue を切る（self-review: design-reviewer）。
 * `streamApiMessage` /
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
 * Issue #223 (part 1/2 of restoring *some* of what SDK-level retry used to
 * give us for free — see the doc comment at the top of this file for why
 * `maxRetries: 0` exists and what it costs): decides whether `error` is
 * worth retrying, using only `APIError#status` (this is the one place in
 * the codebase allowed to depend on the SDK's error shape — the facade
 * (`claude-client.ts`) only imports SDK *types*, never these classes, per
 * docs/adr/0003-llm-backend-isolation.md). Uses the named `APIError` export
 * rather than `Anthropic.APIError` (the static on the default-exported
 * client class) — both refer to the same class at runtime, but the named
 * export doesn't depend on the default export's shape, which keeps this
 * function decoupled from how `Anthropic` itself is constructed/mocked.
 *
 * - 408 (Request Timeout) and 429 (Too Many Requests) are retryable — both
 *   are conventionally transient.
 * - Other 4xx (400/401/403/404/422/…) are the caller's fault or won't change
 *   on retry, so they are not retryable. This includes 409 (Conflict) —
 *   note this is *narrower* than the SDK's own built-in retry policy
 *   (`node_modules/@anthropic-ai/sdk/client.js`), which also retries 409 as
 *   a lock-timeout heuristic. Issue #223's completion criteria explicitly
 *   scope retryable 4xx down to 408/429 only, so this is a deliberate
 *   narrowing, not a full "restore SDK behavior" — self-review, code-reviewer.
 * - 5xx is retryable (server-side, conventionally transient).
 * - Anything without a `status` — `APIConnectionError`,
 *   `APIConnectionTimeoutError`, `APIUserAbortError` (all three extend
 *   `APIError` with `status: undefined`), and any error that isn't an
 *   `APIError` at all (e.g. a bug thrown before the SDK could classify it)
 *   — keeps the pre-#223 uniform "always retry" behavior. This is a
 *   deliberate non-regression: we only ever *narrow* retries for errors we
 *   can positively identify as non-transient; anything unrecognized stays
 *   retryable. Note `APIUserAbortError` specifically: since Issue #176 the
 *   facade forwards its own shared `AbortSignal` into every SDK call, so an
 *   aborted-by-timeout request surfaces here as an `APIUserAbortError` with
 *   no `status` — this function alone would call that "retryable", but the
 *   facade's `runWithTimeoutAndRetry` already checks
 *   `controller.signal.aborted` *before* consulting any retry-eligibility
 *   result and throws `LlmTimeoutError` instead, so the abort case never
 *   actually reaches a retry decision in practice. A future caller of this
 *   function must preserve that "abort check first" ordering — self-review,
 *   code-reviewer/design-reviewer.
 */
export function isRetryableApiError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return true;
  }
  const status = error.status;
  if (status === undefined) {
    return true;
  }
  if (status === 408 || status === 429) {
    return true;
  }
  return status >= 500;
}

/** RFC 9110 §5.6.7 IMF-fixdate — the only `Retry-After` date format handled
 * here (also what `Date.prototype.toUTCString()` produces, which is what
 * this file's own tests — and every server this app talks to — use). This
 * allowlist regex is deliberately stricter than handing the raw header
 * value straight to `Date.parse`: the SDK's underlying JS engine parses far
 * more than the HTTP-date grammar (ISO dates, and even some malformed
 * strings with a leading `-`), which previously let a header value like
 * `"-9999"` — meant to be rejected as an unparsable/negative delay — be
 * silently reinterpreted as a valid far-future date instead (self-review:
 * Codex shadow review + code-reviewer, both independently, Issue #223).
 */
const RETRY_AFTER_HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Issue #223 (part 2/2): extracts the caller's requested wait time (in
 * milliseconds) from `error`'s `Retry-After` response header, per RFC 9110
 * §10.2.3 — either a non-negative integer number of seconds, or an
 * HTTP-date. Returns `undefined` ("no preference expressed") whenever
 * `error` isn't an `APIError` with a `retry-after` header, or the header
 * value is present but unparsable/negative — callers fall back to their own
 * default backoff in that case.
 *
 * Takes `error: unknown` (mirroring {@link isRetryableApiError}'s
 * signature) rather than a bare `Headers` object so both functions do their
 * own SDK-shape unwrapping internally and stay symmetric — a caller (the
 * future `claude-client.ts` wiring in Issue #224) only ever needs to hand
 * over the caught `error`, never reach into `error.headers` itself. Reaching
 * into `.headers` from the facade would require it to narrow `error` to
 * `APIError` (an `instanceof` check, i.e. an SDK *value* import), which is
 * exactly what docs/adr/0003-llm-backend-isolation.md's "SDK value imports
 * stay inside this file" boundary forbids — self-review: design-reviewer.
 *
 * `now` defaults to the current time but is a parameter so tests can pin it
 * (needed for the HTTP-date branch, which is computed relative to "now").
 * The returned wait, if any, is **not** clamped to a "sane" maximum — an
 * absurdly-large-but-syntactically-valid `Retry-After: <seconds>` is
 * returned as-is, only ever rejected (`undefined`) if it's literally
 * `Infinity` (i.e. `seconds * 1000` itself overflows `Number`; a merely
 * huge-but-finite value, e.g. several centuries' worth of milliseconds, is
 * returned unchanged). **This is a real caller hazard, not a hypothetical
 * one**: `Number.isFinite` alone is not enough of a safety net if a caller
 * ever hands this value straight to `setTimeout` — Node's `setTimeout`
 * silently coerces any delay beyond the 32-bit signed integer max
 * (~24.8 days) down to effectively `1`ms (`TimeoutOverflowWarning`), which
 * would make the caller retry *sooner* than an unbounded/default backoff
 * for a value this function correctly parsed as "wait a very long time" —
 * the opposite of what `Retry-After` asked for. A caller that turns this
 * return value into an actual sleep (the future `claude-client.ts` wiring,
 * Issue #224) must clamp it against its own sane upper bound before use;
 * this function only extracts what the header literally said, it doesn't
 * second-guess or bound it — self-review: code-reviewer (round 2).
 *
 * Scope (Issue #223 制約): only the standard `Retry-After` header is read.
 * Non-standard headers some providers also send (e.g. `retry-after-ms`,
 * `x-should-retry`) are out of scope (YAGNI) — see this file's doc comment
 * and the ticket for the rationale.
 */
export function getApiRetryAfterMs(error: unknown, now: Date = new Date()): number | undefined {
  if (!(error instanceof APIError)) {
    return undefined;
  }
  const value = error.headers?.get("retry-after");
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  // Numeric (seconds) form — RFC 9110 only allows a non-negative integer
  // here, so anything else (a leading `-`, decimals, whitespace inside the
  // digits) is treated as "not this form" and falls through to the
  // HTTP-date attempt below (which, per `RETRY_AFTER_HTTP_DATE_RE` above,
  // rejects it too rather than loosely re-parsing it as a date).
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    // `Number.isFinite` is checked on the *product*, not on `seconds` alone
    // — `seconds` itself can be finite (e.g. `1e306`) while `seconds * 1000`
    // overflows to `Infinity`. Checking pre-multiplication was a real bug
    // caught in this file's own self-review (round 2): it let this function
    // return `Infinity`, silently breaking its own "milliseconds" contract.
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  // HTTP-date form (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
  if (!RETRY_AFTER_HTTP_DATE_RE.test(trimmed)) {
    return undefined;
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) {
    return undefined;
  }
  const waitMs = targetMs - now.getTime();
  return waitMs >= 0 ? waitMs : undefined;
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
