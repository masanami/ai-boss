import type Anthropic from "@anthropic-ai/sdk";
import type { LlmBackend } from "../config.js";
import { createApiClient, streamApiMessage, createApiMessage } from "./backends/api-backend.js";

/**
 * Facade over the LLM backends (`api` today, `claude-code` from Issue #79)
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

const DEFAULT_MAX_TOKENS = 1024;

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

/** Discriminated union over the LLM backends. `claude-code` is a placeholder
 * until Issue #79 implements it — no fields beyond the discriminant. */
export type BossLlmClient = { backend: "api"; client: Anthropic } | { backend: "claude-code" };

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
}

/**
 * Creates the LLM client for the given backend (defaults to `api` — the
 * caller wires `loadConfig().llmBackend` through in a later ticket; see the
 * ticket's explicit scope note). Only the `api` backend validates
 * `ANTHROPIC_API_KEY`; `claude-code` performs no key check (FR-10).
 */
export function createClaudeClient(
  env: NodeJS.ProcessEnv,
  backend: LlmBackend = "api",
): BossLlmClient {
  if (backend === "claude-code") {
    return { backend: "claude-code" };
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

function resolveRequest(request: ClaudeMessageRequest): {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  maxTokens: number;
} {
  return {
    model: request.model ?? DEFAULT_MODEL,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

function isToolUseBlock(block: BossContentBlock): block is BossToolUseBlock {
  return block.type === "tool_use";
}

async function dispatchStream(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  onTextDelta?: OnTextDelta,
): Promise<BossLlmMessage> {
  if (client.backend === "claude-code") {
    // Placeholder until Issue #79 implements the claude-code backend.
    throw new Error("claude-code backend is not implemented yet (see Issue #79)");
  }
  return streamApiMessage(client.client, resolveRequest(request), onTextDelta);
}

async function dispatchCreate(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
): Promise<BossLlmMessage> {
  if (client.backend === "claude-code") {
    // Placeholder until Issue #79 implements the claude-code backend.
    throw new Error("claude-code backend is not implemented yet (see Issue #79)");
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
 * NOTE for Issue #79 (claude-code backend): this loop is written
 * backend-agnostically and currently only ever executes for the `api`
 * backend in practice, because {@link dispatchStream}'s `claude-code` branch
 * throws before returning. Per docs/features/claude-code-backend.md 補足決定
 * 「ツール実行主体の一本化」(2), the future `claude-code` `dispatchStream`
 * implementation executes tools itself via in-process MCP handlers — it
 * MUST NOT surface already-executed tools as unexecuted `tool_use` blocks in
 * its returned `BossLlmMessage`, or this loop will re-execute them (double
 * side effects / duplicate `onToolEvent` notifications). If that invariant
 * can't be guaranteed, gate this loop's tool-execution branch on
 * `client.backend === "api"` instead.
 */
export async function streamBossMessage(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  callbacks?: StreamBossMessageCallbacks,
): Promise<BossLlmMessage> {
  const messages: Anthropic.MessageParam[] = [...request.messages];
  let finalMessage: BossLlmMessage = { content: [] };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    finalMessage = await dispatchStream(
      client,
      { ...request, messages },
      callbacks?.onTextDelta,
    );

    const toolUseBlocks = finalMessage.content.filter(isToolUseBlock);
    if (toolUseBlocks.length === 0 || !callbacks?.executeTool) {
      break;
    }

    messages.push({
      role: "assistant",
      content: finalMessage.content as unknown as Anthropic.MessageParam["content"],
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
 */
export async function requestVerdict<T>(
  client: BossLlmClient,
  request: ClaudeMessageRequest,
  toolName: string,
  validate: (input: unknown) => { valid: true; data: T } | { valid: false; error: string },
): Promise<VerdictOutcome<T>> {
  const message = await createBossMessage(client, request);
  const toolUse = message.content.find(
    (block): block is BossToolUseBlock => isToolUseBlock(block) && block.name === toolName,
  );
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
 * (AC-11 — a common mechanism intended for the future `claude-code` backend,
 * implemented and tested standalone in this ticket; not wired into any
 * production call site yet). Do **not** apply this to the `api` backend: it
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
