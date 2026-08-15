import type Anthropic from "@anthropic-ai/sdk";
// Issue #118 の `resolveLlmBackend`（`createClaudeClient` の backend 既定の
// 解決元）と、Issue #117 の `ApiMessageRequest`（thinking / outputConfig を
// 含む api バックエンドのリクエスト型）は目的が異なり、両方必要（マージ解消）。
import { resolveLlmBackend, type LlmBackend } from "../config.js";
import {
  createApiClient,
  streamApiMessage,
  createApiMessage,
  type ApiMessageRequest,
} from "./backends/api-backend.js";
import {
  streamClaudeCodeMessage,
  createClaudeCodeMessage,
  buildClaudeCodeEnv,
  ClaudeCodeUnavailableError,
  CLAUDE_CODE_UNAVAILABLE_HINT,
} from "./backends/claude-code-backend.js";

/** Re-exported so callers/tests can reference the FR-11 error type (and
 * Issue #118's switch-back guidance) without reaching into
 * `backends/claude-code-backend.js` directly — the facade is the intended
 * public surface (補足決定「FR-10 とエラーハンドリングの整合」already
 * documents `ClaudeCodeUnavailableError` as this module's `api` counterpart
 * to `MissingApiKeyError`). Imported as values (not just re-exported) above
 * so `dispatchStream`/`dispatchCreate` below can reference them directly. */
export { ClaudeCodeUnavailableError, CLAUDE_CODE_UNAVAILABLE_HINT };
export type { ClaudeCodeUnavailableReason } from "./backends/claude-code-backend.js";

/** FR-13 / AC-12: re-exported (like `ClaudeCodeUnavailableError` above) so
 * `server/src/index.ts`'s startup hook reaches the `claude-code` backend
 * through the facade rather than importing `backends/claude-code-backend.js`
 * directly — `server/src/llm/` treats this module as the intended public
 * surface (see this file's own doc comment and
 * docs/features/claude-code-backend.md's "アーキテクチャ決定"; self-review:
 * design-reviewer caught the direct import as the one non-facade caller). */
export {
  checkClaudeCodeAvailability,
  nodeExecFileForAvailabilityCheck,
} from "./backends/claude-code-backend.js";

/**
 * Facade over the LLM backends (`api` and, since Issue #79, `claude-code`)
 * used for boss dialogue (chat), re-adjudication (appeals), dashboard
 * comment generation, and notification copy generation.
 *
 * クリティカル設計決定（docs/features/claude-code-backend.md）:
 * - ツール実行主体はファサード配下に一本化する（呼び出し元はツールを
 *   実行しない）。`streamBossMessage` がツールループ・`executeTool`・
 *   `onToolEvent` の発火を内包する（補足決定「ツール実行主体の一本化」）。
 * - `api` バックエンド時のみ `ANTHROPIC_API_KEY` を検査する
 *   （補足決定「FR-10 とエラーハンドリングの整合」）。
 */

export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Hard cap on the number of Claude round-trips within a single
 * `streamBossMessage` tool-use loop. Guards against a runaway tool-use loop
 * (moved here from `chat-messages-route.ts`'s local constant — Issue #78):
 * once reached, the loop stops calling the backend and resolves with
 * whatever the last round returned.
 */
export const MAX_TOOL_ROUNDS = 5;

/**
 * `max_tokens` bounds *thinking + response text combined*, not just the
 * visible reply — it is an upper limit, not a reservation, so raising it
 * does not increase the actual cost of a short response (Issue #117: the
 * previous 1024 was sized only for response text and silently starved
 * `claude-sonnet-5`'s default adaptive thinking, producing a thinking-only
 * turn with `stop_reason: "max_tokens"` and zero visible content). 16000 is
 * the recommended non-streaming default with enough headroom for D3's
 * `effort: "low"` adaptive thinking plus a full boss reply. Kept as a single
 * constant across every call site (KISS) rather than split per-route.
 */
const DEFAULT_MAX_TOKENS = 16_000;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. Configure it in server/.env before using the Claude client.",
    );
    this.name = "MissingApiKeyError";
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

/** Discriminated union over the LLM backends. `claude-code` carries the
 * subprocess environment (FR-09 / AC-06 — built by {@link createClaudeClient}
 * via `buildClaudeCodeEnv` once per client, rather than read directly from
 * `process.env` inside the backend module on every `query()` call) instead
 * of a client handle: the Agent SDK's `query()` (Issue #79) is stateless per
 * call and needs no equivalent of `Anthropic`. self-review (design-reviewer):
 * `createClaudeClient` itself runs per request today (all 4 call sites
 * construct a fresh client per chat/appeal/comment/notification call), so
 * this env is in practice rebuilt from the live `process.env` on every call
 * too — "once here" refers to "once per client, not once per `query()`
 * invocation on that client", not "once for the process's lifetime". */
export type BossLlmClient =
  | { backend: "api"; client: Anthropic }
  | { backend: "claude-code"; env: Record<string, string | undefined> };

export interface BossTextBlock {
  type: "text";
  text: string;
}

export interface BossToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type BossContentBlock = BossTextBlock | BossToolUseBlock;

export interface BossLlmMessage {
  content: BossContentBlock[];
  /**
   * The backend's *unmodified* assistant content blocks, when it can supply
   * them (`api` only — see `backends/api-backend.ts`'s `normalizeMessage`).
   * Used solely by {@link streamBossMessage}'s tool loop to echo the
   * assistant turn back verbatim on the follow-up round.
   *
   * Issue #117: `content` deliberately drops every block type outside
   * `text`/`tool_use`, including `thinking`. That is correct for boss
   * callers, but wrong for the tool loop: with extended thinking enabled,
   * the assistant turn that produced a `tool_use` must be replayed to the
   * API *with its original `thinking` block and signature intact* (the SDK
   * documents the signature as being returned "for multi-turn continuity"),
   * otherwise the follow-up request is rejected. Echoing the normalized
   * content instead would have made every tool-using chat turn fail the
   * moment thinking became reachable — which the `DEFAULT_MAX_TOKENS`
   * increase in this same fix is exactly what makes it reachable.
   *
   * Optional on purpose: `claude-code` does not set it (D6 — that backend
   * runs its own internal tool loop and this facade never replays turns for
   * it), so the loop falls back to `content` there, preserving the existing
   * behavior its tests pin.
   */
  rawContent?: unknown[];
}

/**
 * Creates the LLM client for the given backend. `backend` defaults to
 * `resolveLlmBackend(env)` — i.e. the caller's own `LLM_BACKEND`, falling
 * back to `config.ts`'s `DEFAULT_LLM_BACKEND` (`"claude-code"` since Issue
 * #118) when it is unset. Deliberately resolved *from `env`* rather than from the static
 * default: `env` is already this function's first argument, and a static
 * default would ignore an explicit `LLM_BACKEND=api` whenever a caller omits
 * the argument — routing an owner who deliberately chose the pay-as-you-go
 * path onto the subscription one instead, which is the exact kind of silent
 * backend switch FR-12 forbids (self-review: design-reviewer).
 *
 * Production callers (`app.ts`, `boss-comment.ts`, `notification-body.ts`,
 * `extract-evening-summary.ts`, `session-summary.ts`) all pass `backend`
 * explicitly via `loadConfig(env).llmBackend` or `resolveLlmBackend(env)`, so
 * this default is only exercised by callers that omit it (tests, or any
 * future call site that doesn't need per-request backend selection) — but it
 * now agrees with them instead of diverging.
 *
 * Only the `api` backend validates `ANTHROPIC_API_KEY`; `claude-code`
 * performs no key check (FR-10).
 */
export function createClaudeClient(
  env: NodeJS.ProcessEnv,
  backend: LlmBackend = resolveLlmBackend(env),
): BossLlmClient {
  if (backend === "claude-code") {
    return { backend: "claude-code", env: buildClaudeCodeEnv(env) };
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  return { backend: "api", client: createApiClient(apiKey) };
}

export interface ClaudeMessageRequest {
  /** Defaults to {@link DEFAULT_MODEL}. Callers resolve this from settings. */
  model?: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** Forces (or disables) tool use. Only consumed by {@link createBossMessage}
   * (and, transitively, {@link requestVerdict}) — the chat route
   * (`streamBossMessage`) has no need for it yet. */
  toolChoice?: Anthropic.ToolChoice;
  maxTokens?: number;
  /**
   * Extended-thinking mode for this request. Defaults to `{ type: "disabled"
   * }` in {@link resolveRequest} (Issue #117 fix) rather than being left
   * unset: `claude-sonnet-5` treats an *omitted* `thinking` as `adaptive`
   * (a silent behavior change from Sonnet 4.6, where omission meant no
   * thinking at all), and adaptive thinking alone was enough to exhaust the
   * old 1024-token `max_tokens` default before any reply text was produced.
   * Closing this at the facade means a future call site that forgets to set
   * `thinking` fails safe (no thinking, full `max_tokens` budget goes to the
   * reply) instead of silently reproducing this bug — only call sites that
   * actually want thinking (currently: the chat route, `{ type: "adaptive"
   * }`) need to opt in explicitly. Only consumed by the `api` backend (see
   * `backends/api-backend.ts`) — `claude-code` has no equivalent parameter
   * (D6: `dispatchStream`/`dispatchCreate` never forward it there).
   */
  thinking?: Anthropic.ThinkingConfigParam;
  /**
   * Optional output tuning (currently just `effort`). Note that `effort`
   * governs how much work the model puts into the turn *as a whole* — not
   * just how deep adaptive thinking goes, but also how elaborate the visible
   * reply is — so lowering it is a quality/latency trade-off on the response
   * itself, not only on the hidden reasoning. Left unset by default; the
   * API's own default is `high`. Currently only the chat route sets it
   * (`effort: "low"`, to keep interactive latency and thinking-token cost
   * down). Same `api`-only scope as {@link thinking} above.
   */
  outputConfig?: Anthropic.OutputConfig;
}

export type OnTextDelta = (textDelta: string) => void;

export type ToolExecutionResult = { content: string; isError: boolean };

/** Executes a tool call by name, returning its result. Supplied by the
 * caller (e.g. the chat route binds `db`/`sessionId` via closure); never
 * called by this module directly for the `claude-code` backend, where the
 * in-process MCP handlers are the execution site instead (Issue #79). */
export type BossToolExecutor = (
  name: string,
  input: unknown,
) => ToolExecutionResult | Promise<ToolExecutionResult>;

/** Notified once per executed tool call, after `executeTool` resolves and
 * before the next round is requested — callers use this to relay SSE `tool`
 * events, accumulate summaries, etc. Awaited so the caller's side effects
 * (e.g. `stream.writeSSE`) happen in a deterministic order relative to the
 * next round. */
export type OnToolEvent = (event: {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}) => void | Promise<void>;

export interface StreamBossMessageCallbacks {
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  executeTool?: BossToolExecutor;
}

/** Returns {@link ApiMessageRequest} rather than an inline structural copy of
 * it so the two stay in sync by construction: adding a field on one side
 * without the other is now a compile error (self-review: design-reviewer
 * caught the duplicated shape when `thinking`/`outputConfig` widened it).
 * The import is type-only, so no runtime dependency is added in the
 * facade → backend direction that isn't already there. */
function resolveRequest(request: ClaudeMessageRequest): ApiMessageRequest {
  return {
    model: request.model ?? DEFAULT_MODEL,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Issue #117 fix — see ClaudeMessageRequest.thinking's doc comment for
    // why "disabled" (not "leave unset") is the fail-safe default.
    thinking: request.thinking ?? { type: "disabled" },
    outputConfig: request.outputConfig,
  };
}

function isToolUseBlock(block: BossContentBlock): block is BossToolUseBlock {
  return block.type === "tool_use";
}

/**
 * Issue #118: when the (now-default) `claude-code` backend's execution
 * environment is unavailable, logs {@link CLAUDE_CODE_UNAVAILABLE_HINT} via
 * `console.warn` before letting the error continue to propagate unchanged —
 * the existing error contract (HTTP 500 for chat/appeals, template fallback
 * for dashboard comment / notification body) is untouched, only a warning is
 * added. Every call site that logs a `ClaudeCodeUnavailableError` today logs
 * `err.name` only (never `.message`), per the "log class name only"
 * discipline (see that error type's own doc comment) — the static hint is
 * this module's way of surfacing actionable guidance without leaking
 * request/environment detail into logs. Shared by `dispatchStream` and
 * `dispatchCreate`'s `claude-code` branches so the behavior can't drift
 * between the streaming and non-streaming dispatch paths.
 */
async function runClaudeCodeDispatch<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) {
      console.warn(CLAUDE_CODE_UNAVAILABLE_HINT);
    }
    throw err;
  }
}

/**
 * Dispatches a single streaming round. For `claude-code`, the whole call
 * (Agent SDK `query()`, including its own in-process MCP tool execution) is
 * wrapped in {@link runWithTimeoutAndRetry} (AC-11 · non-functional
 * requirement "信頼性"): the 120s/2-retries policy lives here, at the
 * facade layer, rather than being delegated to the SDK/CLI's own client
 * options (unlike the `api` backend — see that function's doc comment for
 * why doubling up would be wrong). `hasSideEffect` becomes `true` the moment
 * `executeTool` **or** `onTextDelta` is invoked at all (regardless of
 * `executeTool`'s result), which is intentionally conservative: once a
 * DB-writing tool call has been dispatched, or any text has already been
 * streamed to the caller (which relays it via SSE and accumulates it into
 * the message that gets persisted — see `chat-messages-route.ts`'s
 * `fullText`), a later failure in that same attempt must not trigger a
 * retry. Retrying would re-run the whole `query()` from scratch, which would
 * either duplicate the DB write, or duplicate already-relayed text
 * (self-review: without tracking `onTextDelta` too, a mid-stream failure
 * followed by a successful retry would leave the persisted message
 * containing the first attempt's partial text followed by the second
 * attempt's full text). See the non-functional requirement's point 3 and
 * `callbacks.executeTool`'s doc comment.
 */
async function dispatchStream(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  callbacks?: StreamBossMessageCallbacks,
): Promise<BossLlmMessage> {
  if (client.backend === "claude-code") {
    const resolved = resolveRequest(request);
    let sideEffectOccurred = false;
    const trackedOnTextDelta: OnTextDelta | undefined = callbacks?.onTextDelta
      ? (textDelta) => {
          sideEffectOccurred = true;
          callbacks.onTextDelta!(textDelta);
        }
      : undefined;
    const trackedExecuteTool: BossToolExecutor | undefined = callbacks?.executeTool
      ? async (name, input) => {
          sideEffectOccurred = true;
          return callbacks.executeTool!(name, input);
        }
      : undefined;
    return runClaudeCodeDispatch(() =>
      runWithTimeoutAndRetry(
        (signal) =>
          streamClaudeCodeMessage(
            {
              model: resolved.model,
              system: resolved.system,
              messages: resolved.messages,
              tools: resolved.tools,
            },
            {
              onTextDelta: trackedOnTextDelta,
              onToolEvent: callbacks?.onToolEvent,
              executeTool: trackedExecuteTool,
              signal,
              env: client.env,
            },
          ),
        () => sideEffectOccurred,
      ),
    );
  }
  return streamApiMessage(client.client, resolveRequest(request), callbacks?.onTextDelta);
}

/**
 * Dispatches a single non-streaming round (`createBossMessage` /
 * `requestVerdict`). Never executes a DB-writing tool itself — `submit_verdict`
 * has no execution function (see `backends/claude-code-backend.ts`'s doc
 * comment) and the dashboard-comment / notification-body callers pass no
 * tools at all — so `hasSideEffect` is always `false` here: every failure is
 * safe to retry (AC-11).
 */
async function dispatchCreate(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
): Promise<BossLlmMessage> {
  if (client.backend === "claude-code") {
    const resolved = resolveRequest(request);
    return runClaudeCodeDispatch(() =>
      runWithTimeoutAndRetry(
        (signal) =>
          createClaudeCodeMessage(
            {
              model: resolved.model,
              system: resolved.system,
              messages: resolved.messages,
              tools: resolved.tools,
            },
            { signal, env: client.env },
          ),
        () => false,
      ),
    );
  }
  return createApiMessage(client.client, resolveRequest(request));
}

/**
 * Sends `request` to the boss LLM and streams the response, relaying text
 * deltas to `callbacks.onTextDelta` as they arrive. Owns the tool-use loop
 * (moved here from `chat-messages-route.ts` — Issue #78, per the "ツール
 * 実行主体の一本化" decision): when the response contains `tool_use` blocks
 * and `callbacks.executeTool` is supplied, each tool is executed (awaited,
 * in order), `callbacks.onToolEvent` is notified, and a follow-up round is
 * requested with the tool results appended — up to {@link MAX_TOOL_ROUNDS}
 * times. Resolves with the last round's message (which may still include
 * unexecuted `tool_use` blocks if the round cap was hit, or if no
 * `executeTool` was given at all).
 *
 * This loop only ever runs for the `api` backend. For `claude-code` (Issue
 * #79), per docs/features/claude-code-backend.md 補足決定「ツール実行主体の
 * 一本化」(2), the Agent SDK's own in-process MCP handlers are the tool
 * execution site (`backends/claude-code-backend.ts`), and its `query()` call
 * already runs its own internal multi-turn tool loop — so this function
 * makes exactly one {@link dispatchStream} call for `claude-code` and
 * returns its result directly, instead of gating the loop body per-round on
 * `client.backend`. This is the "invariant can't be guaranteed, gate on
 * `client.backend === 'api'` instead" fallback the original design note
 * called for: gating the whole loop (not just the tool-execution branch)
 * sidesteps the double-execution risk entirely, at the cost of this
 * function's returned `BossLlmMessage.content` reflecting the *entire*
 * claude-code turn (all assistant text/tool_use blocks across every
 * SDK-internal round) rather than strictly "the last round's message" — no
 * caller relies on that distinction today (see the backend module's doc
 * comment).
 */
export async function streamBossMessage(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  callbacks?: StreamBossMessageCallbacks,
): Promise<BossLlmMessage> {
  if (client.backend === "claude-code") {
    return dispatchStream(client, request, callbacks);
  }

  const messages: Anthropic.MessageParam[] = [...request.messages];
  let finalMessage: BossLlmMessage = { content: [] };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    finalMessage = await dispatchStream(client, { ...request, messages }, callbacks);

    const toolUseBlocks = finalMessage.content.filter(isToolUseBlock);
    if (toolUseBlocks.length === 0 || !callbacks?.executeTool) {
      break;
    }

    // Replay the assistant turn *verbatim* when the backend gave us the raw
    // blocks (Issue #117): with thinking enabled, dropping the `thinking`
    // block before the `tool_result` breaks the turn — see
    // `BossLlmMessage.rawContent`'s doc comment. Falls back to the
    // normalized content for backends that supply no raw blocks.
    messages.push({
      role: "assistant",
      content: (finalMessage.rawContent ??
        finalMessage.content) as unknown as Anthropic.MessageParam["content"],
    });

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await callbacks.executeTool(block.name, block.input);
      if (callbacks.onToolEvent) {
        await callbacks.onToolEvent({
          name: block.name,
          input: block.input,
          result: result.content,
          isError: result.isError,
        });
      }
      const toolResultMessage = buildToolResultMessage(block.id, result.content, {
        isError: result.isError,
      });
      // buildToolResultMessage always builds an array-form content, so the
      // blocks can be collected without a runtime guard.
      toolResultBlocks.push(...(toolResultMessage.content as Anthropic.ToolResultBlockParam[]));
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  return finalMessage;
}

/**
 * Sends `request` to the boss LLM and resolves with the full response in
 * one round-trip (no streaming, no tool loop). Used by the appeals
 * re-adjudication flow (Issue #48) via {@link requestVerdict}.
 */
export function createBossMessage(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
): Promise<BossLlmMessage> {
  return dispatchCreate(client, request);
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

export type VerdictOutcome<T> =
  | { called: true; result: { valid: true; data: T } | { valid: false; error: string } }
  | { called: false };

/**
 * Single round-trip that expects the model to call `toolName` (the caller
 * sets `request.tools`/`request.toolChoice` to force it). Returns a
 * "verified result, or explicit no-call" contract so callers (e.g. the
 * appeals route) don't need to reach into `message.content` themselves.
 * `validate` is injected by the caller to avoid this module depending on any
 * particular domain (e.g. `decisions/`) — see the ticket's DI requirement.
 *
 * Uses the *last* matching `tool_use` block rather than the first: the `api`
 * backend forces a single tool call via `toolChoice` so there is normally
 * only one match, but `claude-code` has no `tool_choice` equivalent (FR-07 —
 * relies on a prompt instruction instead) and its returned message reflects
 * every round of a multi-turn Agent SDK query, so a model that calls the
 * tool more than once (e.g. retrying after its own malformed first attempt)
 * should have its most recent call win.
 */
export async function requestVerdict<T>(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  toolName: string,
  validate: (input: unknown) => { valid: true; data: T } | { valid: false; error: string },
): Promise<VerdictOutcome<T>> {
  const message = await createBossMessage(client, request);
  let toolUse: BossToolUseBlock | undefined;
  for (const block of message.content) {
    if (isToolUseBlock(block) && block.name === toolName) {
      toolUse = block;
    }
  }
  if (!toolUse) {
    return { called: false };
  }
  return { called: true, result: validate(toolUse.input) };
}

export interface RetryTimeoutOptions {
  /** Overall timeout for the *whole* call, shared across every attempt (not
   * reset per retry — see {@link runWithTimeoutAndRetry}'s doc comment).
   * Defaults to 120s (AC-11). */
  timeoutMs?: number;
  /** Max number of retries after the first attempt. Defaults to 2 (i.e. up
   * to 3 attempts total). */
  maxRetries?: number;
  /** Base delay for the exponential backoff between retries
   * (`baseDelayMs * 2 ** attemptIndex`). */
  baseDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves to a rejection once `signal` aborts (or immediately if it's
 * already aborted). A fresh instance is created per attempt so each is
 * properly consumed by that attempt's own `Promise.race` — `Promise.race`
 * attaches a handler to every racer immediately, so no unhandled-rejection
 * risk even for the "losing" side. Never let a single instance outlive a
 * `Promise.race` call it's not part of (e.g. across a backoff `delay`): if it
 * later rejects with no active racer attached, that *would* be an unhandled
 * rejection. */
function rejectOnAbort(signal: AbortSignal, error: Error): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(error);
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(error), { once: true });
  });
}

/**
 * Runs `attempt` under a unified timeout + exponential-backoff retry policy
 * (AC-11). Wired into {@link dispatchStream}/{@link dispatchCreate}'s
 * `claude-code` branches (Issue #79) — see their doc comments for the
 * `hasSideEffect` contract each passes. Do **not** apply this to the `api` backend: it
 * already delegates its timeout/retry policy to the Anthropic SDK's own
 * `timeout`/`maxRetries` client options (see `backends/api-backend.ts`), and
 * wrapping it here too would compound retries (up to 3 × 3 = 9 attempts) —
 * see docs/features/claude-code-backend.md 非機能要件・信頼性: "`api` バックエ
 * ンドは現行どおり...委譲を変更しない".
 *
 * `timeoutMs` bounds the *whole* call (all retries combined), not each
 * individual attempt: a single `AbortController`/timer is created once up
 * front and shared across every attempt, per
 * docs/features/claude-code-backend.md 非機能要件・信頼性 (2) — "呼び出し全体
 * の期限（120秒）は AbortController で実装し...リクエスト単位タイムアウトや
 * maxTurns で代替しない". `attempt` receives this shared `AbortSignal`, which
 * is aborted once the overall budget elapses; any attempt still in flight (or
 * about to start) at that point is treated as a timeout failure.
 *
 * `hasSideEffect` is consulted after every failed attempt: once it returns
 * `true` (e.g. a tool already wrote to the DB during that attempt), the
 * failure is thrown immediately without retrying — retrying after a
 * side-effecting failure could duplicate the side effect.
 */
export async function runWithTimeoutAndRetry<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  hasSideEffect: () => boolean,
  options: RetryTimeoutOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const controller = new AbortController();
  const timeoutError = new LlmTimeoutError(timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let attemptIndex = 0; ; attemptIndex++) {
      try {
        return await Promise.race([
          attempt(controller.signal),
          rejectOnAbort(controller.signal, timeoutError),
        ]);
      } catch (err) {
        if (controller.signal.aborted) {
          throw timeoutError;
        }
        if (hasSideEffect() || attemptIndex >= maxRetries) {
          throw err;
        }
        // Race the backoff wait against the shared deadline too — otherwise
        // a failure late in the overall budget could overshoot `timeoutMs`
        // by up to the full backoff delay before the caller ever finds out.
        await Promise.race([
          delay(baseDelayMs * 2 ** attemptIndex),
          rejectOnAbort(controller.signal, timeoutError),
        ]);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
