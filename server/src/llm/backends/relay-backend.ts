import type { BossLlmClient, RetryDecision } from "../claude-client.js";
import {
  registerLlmBackend,
  type LlmBackendImplementation,
  type LlmBackendName,
} from "../llm-backend-registry.js";
import {
  RELAY_MESSAGES_DESTINATION,
  type SecureTransportPort,
  type SecureTransportResponse,
} from "../secure-transport-port.js";
import { PLAN_DEFAULT_MODEL_ID } from "../plan-default-model.js";
import { RelayUsageLimitError, type RelayUsageLimit } from "../relay-usage-limit.js";
import {
  AnthropicMessagesHttpError,
  classifyByokAnthropicError,
  createAnthropicMessage,
  streamAnthropicMessage,
  type AnthropicMessagesSendPolicy,
} from "./byok-anthropic-backend.js";
import { parseRetryAfterMs } from "./retry-after.js";

/**
 * LLM 中継（`relay`）のバックエンドの登録関数とエラーの分類（機能仕様
 * docs/features/llm-relay-server.md「アプリ側の接続（S2）」・決定 S2-Q1〜S2-Q4）。
 *
 * 中継は Anthropic Messages の形式を話すため、要求本文の組み立て・SSE／JSON の解釈は
 * `byok-anthropic-backend.ts` の変換器をそのまま使い、宛先（`relay-messages`）・送信前の
 * 検査・2xx 以外の応答の扱いだけを {@link AnthropicMessagesSendPolicy} で差し替える。
 *
 * 製品版のコアのバンドル検査の対象——SDK・Node 組み込みを import しない。
 */

export const RELAY_BACKEND: LlmBackendName = "relay";

export { PLAN_DEFAULT_MODEL_ID };

/** 2xx 以外の応答の本文を読む量の上限（バイト。仮定 A15）。超えたら種類不明として扱う。 */
export const RELAY_ERROR_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * 中継のバックエンドへ、プラン込みの既定の値でない `model` が渡された。解決関数が常に
 * 既定の値を返すため呼び出し側の誤り——黙って直さず送らない（仮定 A16）。再試行不可。
 * `message` は固定（モデル名を含めない）。
 */
export class RelayPlanModelRequiredError extends Error {
  constructor() {
    super("relay backend requires the plan default model");
    this.name = "RelayPlanModelRequiredError";
  }
}

/** 中継の 429 の本文から取り出した `error.type`（既知の 2 種だけ。それ以外は持たない）。 */
type RelayErrorType = "usage_limit_exceeded" | "rate_limit_error";

/**
 * 中継の 2xx 以外の応答（上限到達以外）。本文そのものは持たず、既知の `error.type` だけを
 * 持つ（種類不明・読めない・上限超過は `undefined`）。
 */
export class RelayHttpError extends AnthropicMessagesHttpError {
  readonly errorType?: RelayErrorType;

  constructor(status: number, retryAfter: string | undefined, errorType: RelayErrorType | undefined) {
    super(status, retryAfter);
    this.name = "RelayHttpError";
    this.errorType = errorType;
  }
}

interface ParsedRelayErrorBody {
  type?: RelayErrorType;
  limit: RelayUsageLimit;
}

/** 本文（上限内で読めたもの）から `error.type` と `error.limit` だけを取り出す。 */
function parseRelayErrorBody(bytes: Uint8Array | undefined): ParsedRelayErrorBody {
  const unknown: ParsedRelayErrorBody = { limit: "unknown" };
  if (bytes === undefined) {
    return unknown;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return unknown;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) {
    return unknown;
  }
  const { type, limit } = error as { type?: unknown; limit?: unknown };
  const knownType = type === "usage_limit_exceeded" || type === "rate_limit_error" ? type : undefined;
  return { type: knownType, limit: limit === "daily" || limit === "monthly" ? limit : "unknown" };
}

/**
 * 本文を上限つきで読み、読み終えたら（または上限で打ち切ったら・読み取りに失敗したら）
 * 反復子の `return` を呼んで転送の中止と未読の断片の解放をさせる。Web ストリームの特殊な
 * API に依存せず、反復子を直接回す（WKWebView で `TransformStream` の `cancel` が呼ばれない
 * 前例があるため）。上限を超えた・読めなかったときは `undefined`。
 */
async function readBoundedBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    // 本文が読めなくても、失敗の判定は応答のステータスで続ける（本文の失敗は値に含めない）。
    return undefined;
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // 後始末の失敗は、呼び出し元の失敗より優先しない。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const relaySendPolicy: AnthropicMessagesSendPolicy = {
  destination: RELAY_MESSAGES_DESTINATION,
  assertRequestAllowed(request) {
    if (request.model !== PLAN_DEFAULT_MODEL_ID) {
      throw new RelayPlanModelRequiredError();
    }
  },
  async rejectNon2xx(response: SecureTransportResponse) {
    const parsed = parseRelayErrorBody(await readBoundedBody(response.body, RELAY_ERROR_BODY_LIMIT_BYTES));
    if (response.status === 429 && parsed.type === "usage_limit_exceeded") {
      throw new RelayUsageLimitError(parsed.limit);
    }
    throw new RelayHttpError(response.status, response.headers["retry-after"], parsed.type);
  },
};

/**
 * `relay` のエラーの分類（決定 S2-Q4）:
 * - {@link RelayUsageLimitError}（429 `usage_limit_exceeded`）は再試行不可。
 * - 429 は、`rate_limit_error` と読めたときだけ再試行可（`retry-after` に従う）。JSON でない・
 *   種類が無い／未知・上限超過・読めない 429 は再試行不可（上限到達を再試行で叩き続けない）。
 * - 他は `classifyByokAnthropicError` と同じ規則。
 */
export function classifyRelayError(error: unknown, now: Date = new Date()): RetryDecision {
  if (error instanceof RelayUsageLimitError || error instanceof RelayPlanModelRequiredError) {
    return { retryable: false };
  }
  if (error instanceof AnthropicMessagesHttpError && error.status === 429) {
    if (error instanceof RelayHttpError && error.errorType === "rate_limit_error") {
      return { retryable: true, retryAfterMs: parseRetryAfterMs(error.retryAfter, now) };
    }
    return { retryable: false };
  }
  return classifyByokAnthropicError(error, now);
}

function isRelayClient(client: BossLlmClient): client is BossLlmClient & { backend: "relay" } {
  return client.backend === "relay";
}

/**
 * `relay` を、与えられた転送のポートで `llm-backend-registry.ts` へ登録する。
 * `createClient` は `env` を読まない——ライセンストークンは Rust の保管にあり、TS には渡らない。
 */
export function registerRelayBackend(transport: SecureTransportPort): void {
  const implementation: LlmBackendImplementation = {
    // 中継は Anthropic Messages を話すので、能力は BYOK（Anthropic）と同じ。
    capabilities: { runsOwnToolLoop: false, supportsToolChoice: true, limitsResponseLength: true },
    createClient(): BossLlmClient {
      return { backend: "relay", transport };
    },
    streamRound(client, request, hooks, signal) {
      if (!isRelayClient(client)) {
        throw new Error("relay backend implementation received a non-relay client");
      }
      return streamAnthropicMessage(relaySendPolicy, client.transport, request, hooks.onTextDelta, signal);
    },
    createRound(client, request, signal) {
      if (!isRelayClient(client)) {
        throw new Error("relay backend implementation received a non-relay client");
      }
      return createAnthropicMessage(relaySendPolicy, client.transport, request, signal);
    },
    classifyError: (error: unknown) => classifyRelayError(error),
  };
  registerLlmBackend(RELAY_BACKEND, implementation);
}
