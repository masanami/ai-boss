import type Anthropic from "@anthropic-ai/sdk";
import type {
  BossContentBlock,
  BossLlmClient,
  BossLlmMessage,
  OnTextDelta,
  RetryDecision,
} from "../claude-client.js";
import {
  registerLlmBackend,
  type LlmBackendImplementation,
  type LlmBackendName,
  type ResolvedLlmRequest,
} from "../llm-backend-registry.js";
import {
  SecureTransportError,
  type SecureTransportDestination,
  type SecureTransportPort,
  type SecureTransportResponse,
} from "../secure-transport-port.js";
import { parseRetryAfterMs } from "./retry-after.js";
import { iterateSseDataPayloadTexts } from "./sse-data-payloads.js";
import { assertByokModelAllowed, getOpenAiReasoningEffort, ByokModelNotAllowedError } from "../model-catalog.js";

/**
 * OpenAI Responses の形式の変換器と、BYOK（OpenAI）のバックエンド登録関数
 * （機能仕様 docs/features/llm-provider-abstraction.md クリティカル設計
 * 決定1・2・3・「IF / API（S1）」）。
 *
 * `byok-anthropic-backend.ts`（#581 S2）と同じ構造・命名・テストの作り
 * （模擬の転送のポート）を踏襲する。SDK（OpenAI の npm SDK を含む）を
 * **値として import しない**（製品版のコアのバンドル検査
 * `core-entry.bundle.test.ts` の対象）。
 */

export const BYOK_OPENAI_BACKEND: LlmBackendName = "byok-openai";

/** OpenAI Responses API の宛先の名前（機能仕様「IF / API（S1）」・仮定 A8）。
 * Rust 側の宛先の表（`native/secure-transport/src/destination.rs`）が同じ
 * 名前の行を持つ。 */
export const OPENAI_RESPONSES_DESTINATION: SecureTransportDestination = "openai-responses";

/**
 * 応答のステータスが2xxでないときに投げる失敗（機能仕様「エラーの分類」）。
 * **要求・応答の本文を message に含めない**——`errorCode` は応答本文の
 * `error.code` フィールドの値のみを保持する（機能仕様の非機能要件
 * 「ログ」でいう「エラーの種類」に相当し、秘密ではない——本文・プロンプト・
 * ツールの入力とは異なる）。
 */
export class OpenAiResponsesHttpError extends Error {
  readonly status: number;
  readonly retryAfter?: string;
  readonly errorCode?: string;

  constructor(status: number, retryAfter?: string, errorCode?: string) {
    super(`OpenAI Responses API returned a non-2xx response (status ${status})`);
    this.name = "OpenAiResponsesHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.errorCode = errorCode;
  }
}

/**
 * 応答の解釈中に生じた失敗——SSE の `error`／`response.failed` イベント・
 * 終端のイベント（`response.completed`／`response.incomplete`）前の途絶
 * （ストリーミングのみ）・壊れた JSON
 * （`"malformed-payload"`。SSE の `data:` ペイロード・非ストリーミングの
 * 応答本文のいずれも対象）・2xx の非ストリーミングの応答が失敗を示す
 * （`"failed-response"`。`status: "failed"` または `error` あり）。
 * **応答本文の文字列を message に含めない**
 * （`byok-anthropic-backend.ts` の `AnthropicMessagesStreamError` と同じ
 * 規律）。
 */
type OpenAiResponsesStreamErrorReason =
  | "sse-error-event"
  | "failed-response"
  | "incomplete-stream"
  | "malformed-payload"
  // Issue #637: max_output_tokens 等で打ち切られた未完了の function_call。
  // 同じ要求を再送しても同じ上限で再び打ち切られるだけなので、
  // classifyByokOpenAiError はこの理由を無条件に再試行不可とする。
  | "truncated-function-call";

export class OpenAiResponsesStreamError extends Error {
  readonly reason: OpenAiResponsesStreamErrorReason;

  constructor(reason: OpenAiResponsesStreamErrorReason) {
    super(OpenAiResponsesStreamError.describe(reason));
    this.name = "OpenAiResponsesStreamError";
    this.reason = reason;
  }

  private static describe(reason: OpenAiResponsesStreamErrorReason): string {
    switch (reason) {
      case "sse-error-event":
        return "OpenAI Responses streaming response contained an error/response.failed event";
      case "failed-response":
        return "OpenAI Responses response reported a failed status or an error";
      case "incomplete-stream":
        return "OpenAI Responses streaming response ended before a terminal event";
      case "malformed-payload":
        return "OpenAI Responses response contained a malformed payload";
      case "truncated-function-call":
        // 引数（arguments）・応答本文は含めない（漏洩防止の規律）。
        return "OpenAI Responses response contained a truncated function_call";
    }
  }
}

// ---------------------------------------------------------------------------
// 要求本文の組み立て（機能仕様「Anthropic の形 → OpenAI Responses の対応」）
// ---------------------------------------------------------------------------

type OpenAiInputItem = Record<string, unknown>;

/**
 * ツールの実行結果の `output` の書式（仮定 A4）。OpenAI には `is_error` に
 * 当たる項目が無いため、エラーであることを `output` の文字列そのものへ
 * 表す。成功時の文字列と衝突しないよう固定の接頭辞を付ける——正常な
 * ツール結果がこの接頭辞から始まることは無い（既存のツール実装の規約）。
 */
function formatFunctionCallOutput(content: string, isError: boolean): string {
  return isError ? `[tool error] ${content}` : content;
}

/**
 * `request.messages`（Anthropic 形式）を OpenAI Responses の `input` 配列へ
 * 変換する（機能仕様「Anthropic の形 → OpenAI Responses の対応」表）。
 * - 文字列の content（DB 由来の履歴）→ `{ role, content }` のメッセージ
 * - assistant の配列 content（そのターンの前のラウンドで自分が返した
 *   `rawContent`。`claude-client.ts` の `streamBossMessage` がそのまま
 *   送り返す）→ 項目を**手を加えずに**並べる
 * - user の配列 content（`tool_result` ブロック）→
 *   `type: "function_call_output"`
 */
function buildInputItems(messages: Anthropic.MessageParam[]): OpenAiInputItem[] {
  const items: OpenAiInputItem[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      items.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      // 前のラウンドの OpenAI の出力の項目（rawContent）をそのまま並べる。
      for (const rawItem of message.content as unknown[]) {
        items.push(rawItem as OpenAiInputItem);
      }
      continue;
    }
    for (const block of message.content as Anthropic.ToolResultBlockParam[]) {
      if (block.type !== "tool_result") {
        continue;
      }
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: formatFunctionCallOutput(block.content as string, block.is_error === true),
      });
    }
  }
  return items;
}

function buildTools(tools: Anthropic.Tool[] | undefined): OpenAiInputItem[] | undefined {
  if (!tools) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

function buildToolChoice(toolChoice: Anthropic.ToolChoice | undefined): unknown {
  if (!toolChoice) {
    return undefined;
  }
  switch (toolChoice.type) {
    case "tool":
      return { type: "function", name: toolChoice.name };
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    default:
      return undefined;
  }
}

/** チャット（`thinking: { type: "adaptive" }`）はモデルの一覧の「チャット」
 * 対応の値、それ以外（`{ type: "disabled" }` — `resolveRequest` の既定）は
 * 「推論なし」対応の値を使う（機能仕様「OpenAI の要求本文」受入基準）。 */
function resolveReasoningEffort(modelId: string, thinking: Anthropic.ThinkingConfigParam): string {
  const mode = thinking.type === "adaptive" ? "chat" : "disabled";
  return getOpenAiReasoningEffort(modelId, mode);
}

/**
 * `ResolvedLlmRequest` から OpenAI Responses API の要求本文（JSON 文字列）
 * を組み立てる。`instructions`/`tools`/`tool_choice` が `undefined` の項目は
 * `JSON.stringify` が自動的に落とす（`byok-anthropic-backend.ts` の
 * `buildRequestBody` と同じ規律）。`store`・`previous_response_id` は
 * どちらも組み立てない（機能仕様クリティカル設計決定2）。
 */
function buildRequestBody(request: ResolvedLlmRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.model,
    instructions: request.system,
    input: buildInputItems(request.messages),
    tools: buildTools(request.tools),
    tool_choice: buildToolChoice(request.toolChoice),
    max_output_tokens: request.maxTokens,
    reasoning: { effort: resolveReasoningEffort(request.model, request.thinking) },
    stream,
  });
}

// ---------------------------------------------------------------------------
// 送信（HTTP のエラーの判定を含む）
// ---------------------------------------------------------------------------

/** 本文のバイト列 → 文字列（`byok-anthropic-backend.ts` と同じ、多バイト
 * 文字がバイト列の境界で分割されても壊れない逐次復号）。 */
async function readAllText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** 非2xx の応答本文から `error.code` だけを読む（読めなくても無視する
 * ——429/insufficient_quota の判定に使うだけで、本文全体は保持しない）。 */
async function tryExtractErrorCode(body: AsyncIterable<Uint8Array>): Promise<string | undefined> {
  try {
    const text = await readAllText(body);
    const parsed = JSON.parse(text) as { error?: { code?: string } };
    return parsed.error?.code;
  } catch {
    return undefined;
  }
}

async function sendOpenAiRequest(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  stream: boolean,
  signal: AbortSignal,
): Promise<SecureTransportResponse> {
  // 機能仕様 docs/features/llm-provider-abstraction.md クリティカル設計決定3:
  // streamRound/createRound の入口（転送のポートを呼ぶ前）でモデルの一覧の
  // 関門を通す。
  assertByokModelAllowed("openai", request.model);
  const body = buildRequestBody(request, stream);
  const response = await transport({ destination: OPENAI_RESPONSES_DESTINATION, body }, signal);
  if (response.status < 200 || response.status >= 300) {
    const errorCode = await tryExtractErrorCode(response.body);
    throw new OpenAiResponsesHttpError(response.status, response.headers["retry-after"], errorCode);
  }
  return response;
}

// ---------------------------------------------------------------------------
// SSE の解釈（区切り処理は `sse-data-payloads.ts` で BYOK（Anthropic）と共有）
// ---------------------------------------------------------------------------

function parseJsonWithoutLeakingPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenAiResponsesStreamError("malformed-payload");
  }
}

async function* iterateSseDataPayloads(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  for await (const payload of iterateSseDataPayloadTexts(body)) {
    yield parseJsonWithoutLeakingPayload(payload);
  }
}

// ---------------------------------------------------------------------------
// 応答の出力の項目 → BossLlmMessage（機能仕様「応答の対応」）
// ---------------------------------------------------------------------------

function warnIfNoUsableContent(
  content: BossContentBlock[],
  itemTypes: string[],
  meta: { status?: unknown; model?: unknown; usage?: unknown },
): void {
  if (content.length > 0) {
    return;
  }
  console.warn("byok-openai backend: normalized message has no text/tool_use content", {
    status: meta.status,
    itemTypes,
    model: meta.model,
    usage: meta.usage,
  });
}

function extractOutputText(messageItem: Record<string, unknown>): string | undefined {
  const parts = (messageItem.content as unknown[] | undefined) ?? [];
  const texts = parts
    .filter((part) => (part as Record<string, unknown>).type === "output_text")
    .map((part) => (part as Record<string, unknown>).text as string);
  return texts.length > 0 ? texts.join("") : undefined;
}

/** function_call の項目が未完了か（Issue #637）。次の2条件の OR:
 * (a) 項目の `status` が存在し `"completed"` でない（`"incomplete"` /
 *     `"in_progress"` 等）——`status` の無い項目は既存フィクスチャ互換のため
 *     completed 扱い。
 * (b) 応答自体が incomplete（`responseIncomplete`。呼び出し元が
 *     `response.status === "incomplete"` とストリーミングの終端イベント種別の
 *     両方を確実に判定して渡す——`interpretResponse` 内でも `response.status`
 *     を重ねて見る）。
 * 未完了なら**引数を解釈する前に** true を返し、呼び出し元は
 * `parseJsonWithoutLeakingPayload` を呼ばない（打ち切られた途中までの JSON を
 * 誤って malformed-payload〔再試行可〕に分類しないため）。 */
function isIncompleteFunctionCallItem(item: Record<string, unknown>, responseIncomplete: boolean): boolean {
  const itemStatus = item.status;
  const itemIncomplete = itemStatus !== undefined && itemStatus !== "completed";
  return itemIncomplete || responseIncomplete;
}

/** `response`（`response.completed`／`response.incomplete` イベントの
 * `response` フィールド、また非ストリーミング応答の JSON そのもの）→
 * `BossLlmMessage`。出力の項目配列全体（reasoning を含む）を、同じ順・同じ値
 * で `rawContent` に入れる（機能仕様「応答の対応」）。
 *
 * `terminalWasIncomplete`（ストリーミングの終端イベントが
 * `response.incomplete` だったか）は非ストリーミング呼び出しでは常に
 * `false` だが、`response.status === "incomplete"` は下で重ねて見るため
 * 判定は落ちない（Issue #637: 未完了の function_call の検出）。 */
function interpretResponse(response: Record<string, unknown>, terminalWasIncomplete = false): BossLlmMessage {
  const output = (response.output as unknown[] | undefined) ?? [];
  const responseIncomplete = terminalWasIncomplete || response.status === "incomplete";
  const content: BossContentBlock[] = [];
  const itemTypes: string[] = [];
  for (const rawItem of output) {
    const item = rawItem as Record<string, unknown>;
    itemTypes.push(item.type as string);
    if (item.type === "message") {
      const text = extractOutputText(item);
      if (text !== undefined) {
        content.push({ type: "text", text });
      }
    } else if (item.type === "function_call") {
      // Issue #637: 引数を解釈する前に未完了判定を行う——打ち切られた
      // function_call の arguments は途中までの JSON であることが多く、
      // 先に parseJsonWithoutLeakingPayload を呼ぶと malformed-payload
      // （再試行可）に誤分類されてしまう。
      if (isIncompleteFunctionCallItem(item, responseIncomplete)) {
        throw new OpenAiResponsesStreamError("truncated-function-call");
      }
      const rawArguments = (item.arguments as string) ?? "{}";
      content.push({
        type: "tool_use",
        id: item.call_id as string,
        name: item.name as string,
        input: parseJsonWithoutLeakingPayload(rawArguments),
      });
    }
  }
  warnIfNoUsableContent(content, itemTypes, { status: response.status, model: response.model, usage: response.usage });
  return { content, rawContent: [...output] };
}

async function parseStreamingResponse(
  body: AsyncIterable<Uint8Array>,
  onTextDelta: OnTextDelta | undefined,
): Promise<BossLlmMessage> {
  let sawCompleted = false;
  let completedResponse: Record<string, unknown> | undefined;
  // Issue #637: 終端イベントが response.incomplete だったかを覚えておき、
  // interpretResponse へ渡す（未完了の function_call の検出条件の一部——
  // response.status だけでなく、この終端イベント種別も確実に判定する）。
  let terminalWasIncomplete = false;

  for await (const rawEvent of iterateSseDataPayloads(body)) {
    const event = rawEvent as Record<string, unknown>;
    switch (event.type) {
      case "response.output_text.delta": {
        const delta = (event.delta as string) ?? "";
        onTextDelta?.(delta);
        break;
      }
      // self-review（code-reviewer/design-reviewer 双方が独立に指摘・
      // CONFIRMED/PLAUSIBLE）: max_output_tokens を使い切った打ち切り
      // （`status: "incomplete"`）は `response.completed` ではなく
      // `response.incomplete` で終わりうる。`response.completed` だけを
      // 正常終了とみなすと、この終端が「途絶」に誤分類され、再試行可と
      // 判定されて同一の打ち切られた要求が課金されたまま再送される
      // （機能仕様「応答の対応」: `status: "incomplete"` はメタ情報だけを
      // ログに出す——正常な終端として扱う。非ストリーミングの
      // `interpretResponse` は既にこれを例外にしていない。ただし Issue #637:
      // 出力に未完了の function_call があれば別途 truncated-function-call
      // として失敗させる——`interpretResponse` 参照）。
      case "response.completed":
      case "response.incomplete":
        sawCompleted = true;
        completedResponse = event.response as Record<string, unknown>;
        terminalWasIncomplete = event.type === "response.incomplete";
        break;
      case "response.failed":
      case "error":
        throw new OpenAiResponsesStreamError("sse-error-event");
      default:
        // response.created・response.in_progress・response.output_item.* ・
        // response.function_call_arguments.delta 等は無視する（完了時の
        // output からまとめて解釈するため、途中経過のイベントは不要——
        // YAGNI）。
        break;
    }
  }

  if (!sawCompleted || !completedResponse) {
    throw new OpenAiResponsesStreamError("incomplete-stream");
  }
  return interpretResponse(completedResponse, terminalWasIncomplete);
}

function parseNonStreamingResponse(text: string): BossLlmMessage {
  const response = parseJsonWithoutLeakingPayload(text) as Record<string, unknown>;
  // PR #633 の Codex の指摘（P2）: 2xx でも応答が失敗を示すなら、成功扱いで
  // 空の内容に正規化せず、ストリーミングの `response.failed` と同じ失敗の
  // クラス（＝同じ分類・再試行可）で投げる。`status: "incomplete"` は
  // ストリーミングの `response.incomplete` と揃えて正常な応答として解釈する
  // （ただし未完了の function_call を含めば truncated-function-call で失敗
  // する——Issue #637・`interpretResponse` 参照）。
  if (response.status === "failed" || (response.error !== undefined && response.error !== null)) {
    throw new OpenAiResponsesStreamError("failed-response");
  }
  return interpretResponse(response);
}

// ---------------------------------------------------------------------------
// バックエンドの実装本体
// ---------------------------------------------------------------------------

async function streamOpenAiMessage(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  onTextDelta: OnTextDelta | undefined,
  signal: AbortSignal,
): Promise<BossLlmMessage> {
  const response = await sendOpenAiRequest(transport, request, true, signal);
  return parseStreamingResponse(response.body, onTextDelta);
}

async function createOpenAiMessage(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  signal: AbortSignal,
): Promise<BossLlmMessage> {
  const response = await sendOpenAiRequest(transport, request, false, signal);
  const text = await readAllText(response.body);
  return parseNonStreamingResponse(text);
}

/**
 * BYOK（OpenAI）のエラーの分類（機能仕様「エラーの分類」）。
 * - {@link ByokModelNotAllowedError}（モデルの一覧の関門）は常に再試行不可。
 * - {@link SecureTransportError} は `"connection"` のみ再試行可。
 * - {@link OpenAiResponsesHttpError} は 408/429/5xx が再試行可（`retry-after`
 *   があれば待ち時間も返す）。ただし 429 かつ `errorCode ===
 *   "insufficient_quota"` は再試行不可（残高・クォータ切れは再試行で直らない
 *   ——機能仕様「エラーの分類」）。他の 4xx は再試行不可。
 * - {@link OpenAiResponsesStreamError} の理由が `"truncated-function-call"`
 *   （max_output_tokens 等で打ち切られた未完了の function_call）は無条件に
 *   再試行不可（Issue #637 クリティカル設計決定: 同じ要求の再送は同じ上限で
 *   再び打ち切られるだけで直らない）。
 * - それ以外（他の理由の {@link OpenAiResponsesStreamError} を含む）は
 *   `byok-anthropic-backend.ts` の `classifyByokAnthropicError` と同じ既定
 *   （正体不明の失敗は再試行可）。
 */
export function classifyByokOpenAiError(error: unknown, now: Date = new Date()): RetryDecision {
  if (error instanceof ByokModelNotAllowedError) {
    return { retryable: false };
  }
  if (error instanceof SecureTransportError) {
    return { retryable: error.kind === "connection" };
  }
  if (error instanceof OpenAiResponsesHttpError) {
    if (error.status === 429 && error.errorCode === "insufficient_quota") {
      return { retryable: false };
    }
    const retryable = error.status === 408 || error.status === 429 || error.status >= 500;
    return { retryable, retryAfterMs: parseRetryAfterMs(error.retryAfter, now) };
  }
  if (error instanceof OpenAiResponsesStreamError && error.reason === "truncated-function-call") {
    return { retryable: false };
  }
  return { retryable: true };
}

function isByokOpenAiClient(client: BossLlmClient): client is BossLlmClient & { backend: "byok-openai" } {
  return client.backend === "byok-openai";
}

/**
 * BYOK（OpenAI）のバックエンドを、与えられた転送のポートで
 * `llm-backend-registry.ts` へ登録する（機能仕様「機能全体の設計」・
 * クリティカル設計決定1）。`createClient` は `env` を読まない
 * （`byok-anthropic-backend.ts` と同じ規律）。
 *
 * 製品版のエントリ（`core-entry.ts`）はこの関数を**呼ばずに re-export する
 * だけ**（案 A。S1 は登録しない——`registeredCoreLlmBackendNames()` は空の
 * まま）。
 */
export function registerByokOpenAiBackend(transport: SecureTransportPort): void {
  const implementation: LlmBackendImplementation = {
    // 機能仕様クリティカル設計決定1: BYOK（OpenAI）は「ループを自分で
    // 回さない・強制に対応する・応答長を制限できる」と宣言する。
    capabilities: { runsOwnToolLoop: false, supportsToolChoice: true, limitsResponseLength: true },
    createClient(): BossLlmClient {
      return { backend: "byok-openai", transport };
    },
    streamRound(client, request, hooks, signal) {
      if (!isByokOpenAiClient(client)) {
        throw new Error("byok-openai backend implementation received a non-byok-openai client");
      }
      return streamOpenAiMessage(client.transport, request, hooks.onTextDelta, signal);
    },
    createRound(client, request, signal) {
      if (!isByokOpenAiClient(client)) {
        throw new Error("byok-openai backend implementation received a non-byok-openai client");
      }
      return createOpenAiMessage(client.transport, request, signal);
    },
    classifyError: (error: unknown) => classifyByokOpenAiError(error),
  };
  registerLlmBackend(BYOK_OPENAI_BACKEND, implementation);
}
