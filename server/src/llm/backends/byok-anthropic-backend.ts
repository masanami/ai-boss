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
  ANTHROPIC_MESSAGES_DESTINATION,
  SecureTransportError,
  type SecureTransportPort,
  type SecureTransportResponse,
} from "../secure-transport-port.js";
import { parseRetryAfterMs } from "./retry-after.js";

/**
 * SDK を使わない Anthropic Messages のクライアントと、BYOK（Anthropic）の
 * バックエンド登録関数（機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定6・「IF / API（S2）」）。
 *
 * `@anthropic-ai/sdk` を**値として import しない**（製品版のコアのバンドル
 * 検査 `core-entry.bundle.test.ts` の対象——`core-entry.ts` がこのモジュールの
 * {@link registerByokAnthropicBackend} を呼ばずに re-export するため、
 * このファイルは到達可能な core バンドルの一部になる）。要求本文の組み立て・
 * SSE と JSON の解釈・`rawContent` の保持・エラーの分類・中止のすべてを
 * 自前で持つ。
 */

export const BYOK_ANTHROPIC_BACKEND: LlmBackendName = "byok-anthropic";

/**
 * 応答のステータスが 2xx でないときに投げる失敗（機能仕様「IF / API
 * （S2）」「HTTP のエラー」）。**本文（要求・応答いずれも）を message に
 * 含めない**——ステータスと `retry-after` の生の値だけを持つ。
 */
export class AnthropicMessagesHttpError extends Error {
  readonly status: number;
  readonly retryAfter?: string;

  constructor(status: number, retryAfter?: string) {
    super(`Anthropic Messages API returned a non-2xx response (status ${status})`);
    this.name = "AnthropicMessagesHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * 応答の解釈中に生じた失敗——SSE の `error` イベント・`message_stop` 前の
 * 途絶（ストリーミングのみ）に加え、**壊れた JSON（`"malformed-payload"`。
 * SSE の `data:` ペイロード・`tool_use` の `input_json_delta` の連結・
 * 非ストリーミングの応答本文のいずれも対象）**（self-review 2周目:
 * code-reviewer が「非ストリーミングも対象だがコメントがストリーミング専用
 * のままだった」と指摘・CONFIRMED）。**応答本文の文字列を message に含めない**
 * ——固定の文言のみ（`parseJsonWithoutLeakingPayload` 参照）。
 */
export class AnthropicMessagesStreamError extends Error {
  constructor(reason: "sse-error-event" | "incomplete-stream" | "malformed-payload") {
    super(AnthropicMessagesStreamError.describe(reason));
    this.name = "AnthropicMessagesStreamError";
  }

  private static describe(reason: "sse-error-event" | "incomplete-stream" | "malformed-payload"): string {
    switch (reason) {
      case "sse-error-event":
        return "Anthropic Messages streaming response contained an SSE error event";
      case "incomplete-stream":
        return "Anthropic Messages streaming response ended before message_stop";
      case "malformed-payload":
        // self-review（code-reviewer/design-reviewer 双方が独立に指摘・
        // CONFIRMED）: `JSON.parse` が投げる SyntaxError の message には
        // 解釈できなかった入力の断片（応答本文）がそのまま入る。ここでは
        // その断片を一切引かず、固定の文言だけにする。
        return "Anthropic Messages response contained a malformed payload";
    }
  }
}

// ---------------------------------------------------------------------------
// 要求本文の組み立て（機能仕様「要求本文」・仮定 A14）
// ---------------------------------------------------------------------------

/**
 * `ResolvedLlmRequest` から Anthropic Messages API の要求本文（JSON文字列）
 * を組み立てる。`system`/`tools`/`tool_choice`/`output_config` が
 * `undefined` の項目は `JSON.stringify` が自動的に落とす（仮定 A14: 項目
 * ごと省く。`null` を入れない）ため、明示的な条件分岐は不要——`api` バック
 * エンド（`api-backend.ts`）の `streamApiMessage`/`createApiMessage` と同じ
 * 項目・同じ値を送る。
 */
function buildRequestBody(request: ResolvedLlmRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.toolChoice,
    thinking: request.thinking,
    output_config: request.outputConfig,
    stream,
  });
}

// ---------------------------------------------------------------------------
// 送信（HTTP のエラーの判定を含む）
// ---------------------------------------------------------------------------

async function sendAnthropicRequest(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  stream: boolean,
  signal: AbortSignal,
): Promise<SecureTransportResponse> {
  const body = buildRequestBody(request, stream);
  const response = await transport({ destination: ANTHROPIC_MESSAGES_DESTINATION, body }, signal);
  if (response.status < 200 || response.status >= 300) {
    // 2xx でない応答は text/tool_use として解釈しない（本文は読まない・
    // onTextDelta も呼ばない）——機能仕様「HTTP のエラー」。
    throw new AnthropicMessagesHttpError(response.status, response.headers["retry-after"]);
  }
  return response;
}

// ---------------------------------------------------------------------------
// 本文のバイト列 → 文字列（多バイト文字がバイト列の境界で分割されても壊れ
// ない、TextDecoder の逐次復号。Buffer はバンドル検査で使えない）
// ---------------------------------------------------------------------------

async function readAllText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of body) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// ---------------------------------------------------------------------------
// SSE の解釈
// ---------------------------------------------------------------------------

/** `rawEvent`（`\n\n` で区切られた1イベント分のテキスト）から `data:` 行の
 * 値を取り出す（複数の `data:` 行は `\n` で連結する——SSE の仕様どおり。
 * Anthropic は通常1イベント1行だが、将来の拡張にも耐える）。`data:` 行が
 * 無ければ `undefined`（例: 空行のみのイベント）。 */
function extractSseDataPayload(rawEvent: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length > 0 ? dataLines.join("\n") : undefined;
}

/**
 * `JSON.parse` を、失敗時に本文の断片を漏らさない形でラップする
 * （self-review: code-reviewer/design-reviewer 双方が独立に指摘・
 * CONFIRMED。V8 の `SyntaxError#message` は解釈できなかった入力の断片
 * ——応答本文——をそのまま含むため、素の `JSON.parse` の失敗をそのまま
 * 伝播させると受入基準（S2）「BYOK（Anthropic）が投げる失敗の値の message
 * に...応答本文の文字列が含まれない」に反する）。
 */
function parseJsonWithoutLeakingPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AnthropicMessagesStreamError("malformed-payload");
  }
}

/** 本文のバイト列の非同期の列から、SSE の `data:` ペイロード（JSON として
 * 解釈した値）を順に生成する。断片の区切りが SSE イベントの途中・多バイト
 * 文字の途中にあっても、`\n\n` の境界が揃うまでバッファへ溜めるので壊れ
 * ない。 */
async function* iterateSseDataPayloads(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = extractSseDataPayload(rawEvent);
      if (payload !== undefined) {
        yield parseJsonWithoutLeakingPayload(payload);
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const trimmed = buffer.trim();
  if (trimmed !== "") {
    const payload = extractSseDataPayload(trimmed);
    if (payload !== undefined) {
      yield parseJsonWithoutLeakingPayload(payload);
    }
  }
}

interface AccumulatingBlock {
  type: string;
  text: string;
  toolUseId?: string;
  toolUseName?: string;
  partialJson: string;
  thinkingText: string;
  signature: string;
  redactedData?: unknown;
  /** `text`/`tool_use`/`thinking`/`redacted_thinking` 以外の型（現行のボスは
   * 使わない——仮定 A15）は、`content_block_start` で受け取った値をそのまま
   * `rawContent` へ残す（デルタは解釈しない。YAGNI）。 */
  fallbackInitial?: unknown;
}

function finalizeBlock(block: AccumulatingBlock): { normalized?: BossContentBlock; raw: unknown } {
  switch (block.type) {
    case "text":
      return { normalized: { type: "text", text: block.text }, raw: { type: "text", text: block.text } };
    case "tool_use": {
      const input = block.partialJson === "" ? {} : parseJsonWithoutLeakingPayload(block.partialJson);
      const raw = { type: "tool_use", id: block.toolUseId, name: block.toolUseName, input };
      return {
        normalized: { type: "tool_use", id: block.toolUseId!, name: block.toolUseName!, input },
        raw,
      };
    }
    case "thinking":
      return { raw: { type: "thinking", thinking: block.thinkingText, signature: block.signature } };
    case "redacted_thinking":
      return { raw: { type: "redacted_thinking", data: block.redactedData } };
    default:
      return { raw: block.fallbackInitial ?? { type: block.type } };
  }
}

/** 応答に `text`/`tool_use` が1つも無いときの `console.warn`（`api-backend.
 * ts` の `normalizeMessage` と同じ規律: 本文・thinking・ツールの入力は出さ
 * ず、ブロックの型・停止理由・モデル・トークン数だけを出す）。 */
function warnIfNoUsableContent(
  content: BossContentBlock[],
  blockTypes: string[],
  meta: { stopReason?: string; model?: string; usage?: unknown },
): void {
  if (content.length > 0) {
    return;
  }
  console.warn("byok-anthropic backend: normalized message has no text/tool_use content", {
    stopReason: meta.stopReason,
    blockTypes,
    model: meta.model,
    usage: meta.usage,
  });
}

async function parseStreamingResponse(
  body: AsyncIterable<Uint8Array>,
  onTextDelta: OnTextDelta | undefined,
): Promise<BossLlmMessage> {
  const blocksByIndex = new Map<number, AccumulatingBlock>();
  let sawMessageStop = false;
  let model: string | undefined;
  let stopReason: string | undefined;
  let usage: unknown;

  for await (const rawEvent of iterateSseDataPayloads(body)) {
    const event = rawEvent as Record<string, unknown>;
    switch (event.type) {
      case "message_start": {
        const message = event.message as Record<string, unknown> | undefined;
        model = message?.model as string | undefined;
        usage = message?.usage;
        break;
      }
      case "content_block_start": {
        const index = event.index as number;
        const contentBlock = (event.content_block as Record<string, unknown>) ?? {};
        const type = contentBlock.type as string;
        const block: AccumulatingBlock = {
          type,
          text: "",
          partialJson: "",
          thinkingText: "",
          signature: "",
        };
        if (type === "tool_use") {
          block.toolUseId = contentBlock.id as string;
          block.toolUseName = contentBlock.name as string;
        } else if (type === "redacted_thinking") {
          block.redactedData = contentBlock.data;
        } else if (type !== "text" && type !== "thinking") {
          block.fallbackInitial = contentBlock;
        }
        blocksByIndex.set(index, block);
        break;
      }
      case "content_block_delta": {
        const index = event.index as number;
        const block = blocksByIndex.get(index);
        if (!block) {
          break;
        }
        const delta = (event.delta as Record<string, unknown>) ?? {};
        switch (delta.type) {
          case "text_delta": {
            const textDelta = (delta.text as string) ?? "";
            block.text += textDelta;
            onTextDelta?.(textDelta);
            break;
          }
          case "input_json_delta":
            block.partialJson += (delta.partial_json as string) ?? "";
            break;
          case "thinking_delta":
            block.thinkingText += (delta.thinking as string) ?? "";
            break;
          case "signature_delta":
            block.signature += (delta.signature as string) ?? "";
            break;
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason !== undefined) {
          stopReason = delta.stop_reason as string;
        }
        if (event.usage !== undefined) {
          usage = event.usage;
        }
        break;
      }
      case "message_stop":
        sawMessageStop = true;
        break;
      case "error":
        throw new AnthropicMessagesStreamError("sse-error-event");
      case "content_block_stop":
      case "ping":
      default:
        // ping・content_block_stop はブロックの確定を持たない（確定は末尾の
        // index 順の走査でまとめて行う）。未知の type も無視する（YAGNI）。
        break;
    }
  }

  if (!sawMessageStop) {
    throw new AnthropicMessagesStreamError("incomplete-stream");
  }

  const content: BossContentBlock[] = [];
  const rawContent: unknown[] = [];
  const blockTypes: string[] = [];
  // self-review（design-reviewer, CONFIRMED）: 応答のブロックの**index の
  // 順**（受入基準）に並べる。実運用の Anthropic は content_block_start を
  // 昇順の index で送るため到達順と一致するが、契約としては到達順ではなく
  // index の値そのもので並べる（到達順に依存すると、将来の実装変更や
  // プロキシの並べ替えで契約が崩れる）。
  const sortedIndices = [...blocksByIndex.keys()].sort((a, b) => a - b);
  for (const index of sortedIndices) {
    const block = blocksByIndex.get(index)!;
    const { normalized, raw } = finalizeBlock(block);
    blockTypes.push(block.type);
    if (normalized) {
      content.push(normalized);
    }
    rawContent.push(raw);
  }

  warnIfNoUsableContent(content, blockTypes, { stopReason, model, usage });

  return { content, rawContent };
}

function parseNonStreamingResponse(text: string): BossLlmMessage {
  const message = parseJsonWithoutLeakingPayload(text) as {
    content: unknown[];
    model?: string;
    stop_reason?: string;
    usage?: unknown;
  };
  const content: BossContentBlock[] = [];
  const blockTypes: string[] = [];
  for (const rawBlock of message.content) {
    const block = rawBlock as Record<string, unknown>;
    blockTypes.push(block.type as string);
    if (block.type === "text") {
      content.push({ type: "text", text: block.text as string });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      });
    }
  }
  warnIfNoUsableContent(content, blockTypes, {
    stopReason: message.stop_reason,
    model: message.model,
    usage: message.usage,
  });
  // 応答の content 全体（thinking を含む）を、同じ順・同じ値で rawContent
  // に入れる（機能仕様「非ストリーミングの応答の解釈」）。
  return { content, rawContent: message.content };
}

// ---------------------------------------------------------------------------
// バックエンドの実装本体
// ---------------------------------------------------------------------------

async function streamAnthropicMessage(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  onTextDelta: OnTextDelta | undefined,
  signal: AbortSignal,
): Promise<BossLlmMessage> {
  const response = await sendAnthropicRequest(transport, request, true, signal);
  return parseStreamingResponse(response.body, onTextDelta);
}

async function createAnthropicMessage(
  transport: SecureTransportPort,
  request: ResolvedLlmRequest,
  signal: AbortSignal,
): Promise<BossLlmMessage> {
  const response = await sendAnthropicRequest(transport, request, false, signal);
  const text = await readAllText(response.body);
  return parseNonStreamingResponse(text);
}

/**
 * BYOK（Anthropic）のエラーの分類（機能仕様「エラーの分類」）。`api` の
 * `classifyApiError`（`isRetryableApiError`）と同じ規則を SDK なしで持つ:
 * - {@link SecureTransportError} は `"connection"`（接続失敗）のみ再試行可。
 *   他の種類（宛先不明・キー未登録・キーの保管の失敗・不正なヘッダ・要求ID
 *   の重複・リダイレクト拒否・中止）は再試行不可。
 * - {@link AnthropicMessagesHttpError} は 408/429/5xx が再試行可（`retry-
 *   after` があれば待ち時間も返す）、他の 4xx は再試行不可。
 * - それ以外（{@link AnthropicMessagesStreamError} を含む——SSE の `error`
 *   イベント・`message_stop` 前の途絶・壊れた JSON（`"malformed-payload"`。
 *   ストリーミング・非ストリーミングいずれの経路も対象）はいずれも
 *   `status` を持たない）は、`api-backend.ts` の `isRetryableApiError` が
 *   「正体不明の失敗は再試行可」とする既定と同じく、再試行可のままにする
 *   （課金される要求の再送になる点は、`retryable: true` を明示的に確かめる
 *   テストがこの既定を意図どおりと固定している）。
 */
export function classifyByokAnthropicError(error: unknown, now: Date = new Date()): RetryDecision {
  if (error instanceof SecureTransportError) {
    return { retryable: error.kind === "connection" };
  }
  if (error instanceof AnthropicMessagesHttpError) {
    const retryable =
      error.status === 408 || error.status === 429 || error.status >= 500;
    return { retryable, retryAfterMs: parseRetryAfterMs(error.retryAfter, now) };
  }
  return { retryable: true };
}

function isByokAnthropicClient(
  client: BossLlmClient,
): client is BossLlmClient & { backend: "byok-anthropic" } {
  return client.backend === "byok-anthropic";
}

/**
 * BYOK（Anthropic）のバックエンドを、与えられた転送のポートで
 * `llm-backend-registry.ts` へ登録する（機能仕様「BYOK（Anthropic）の登録と
 * 要求」）。`createClient` は `env` を読まない——キーの値を受け取る場所を
 * TS 側に作らない（クリティカル設計決定6）。
 *
 * 製品版のエントリ（`core-entry.ts`）はこの関数を**呼ばずに re-export する
 * だけ**（親の決定・案 (A)）——実際に呼ぶのは S3 の Tauri の器。
 */
export function registerByokAnthropicBackend(transport: SecureTransportPort): void {
  const implementation: LlmBackendImplementation = {
    // BYOK（Anthropic）は api と同じ能力を宣言する（機能仕様クリティカル
    // 設計決定5: 「BYOK（Anthropic）＝ 回さない・対応する・制限できる」）。
    capabilities: { runsOwnToolLoop: false, supportsToolChoice: true, limitsResponseLength: true },
    // `env` は読まない——キーの値を受け取る場所を TS 側に作らない
    // （クリティカル設計決定6）。`LlmBackendImplementation.createClient` の
    // シグネチャ（`(env: AppEnv) => BossLlmClient`）とは、パラメータを
    // 省略した関数も構造的に適合する。
    createClient(): BossLlmClient {
      return { backend: "byok-anthropic", transport };
    },
    streamRound(client, request, hooks, signal) {
      if (!isByokAnthropicClient(client)) {
        throw new Error("byok-anthropic backend implementation received a non-byok-anthropic client");
      }
      return streamAnthropicMessage(client.transport, request, hooks.onTextDelta, signal);
    },
    createRound(client, request, signal) {
      if (!isByokAnthropicClient(client)) {
        throw new Error("byok-anthropic backend implementation received a non-byok-anthropic client");
      }
      return createAnthropicMessage(client.transport, request, signal);
    },
    classifyError: (error: unknown) => classifyByokAnthropicError(error),
  };
  registerLlmBackend(BYOK_ANTHROPIC_BACKEND, implementation);
}
