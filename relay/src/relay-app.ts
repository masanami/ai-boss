import { Hono } from "hono";
import {
  DEFAULT_MAX_BUFFERED_RESPONSE_BYTES,
  RelayConfigError,
  validateRelayConfig,
  type RelayConfig,
  type RelayModel,
} from "./config.js";
import { relayErrorResponse, type RelayErrorType } from "./error-response.js";
import { rewriteForModel } from "./model-rewrite.js";
import {
  UpstreamFailure,
  type Authenticate,
  type RelayLogRecord,
  type RelayLogger,
  type UpstreamFetch,
} from "./ports.js";
import { validateMessagesRequest } from "./request-validation.js";
import {
  costUnits,
  createJsonUsageMeter,
  createSseUsageMeter,
  maxCostUnits,
  periodKeys,
  scaledUnits,
  type TokenUsage,
} from "./usage-metering.js";
import type { ReserveRequest, SettleOutcome, UsageStore } from "./usage-store.js";

/**
 * LLM 中継サーバーのコア（機能仕様 docs/features/llm-relay-server.md）。
 *
 * `POST /v1/messages` で Anthropic Messages 形式の要求を受け、次の順に処理する
 * （「機能全体の設計」の「処理の順序」）。最初に失敗した段階の応答を返す:
 * (1) 認証 (2) 入力量の上限 (3) JSON の解釈と項目の検査 (4) 既定モデルの
 * 解決と書き換え (5) 送信前の予約 (6) 上流への転送 (7) 精算。
 *
 * Web 標準の API（`fetch`・`Request`・`Response`・`ReadableStream`）と Hono
 * だけで書く（実行基盤の非依存。`relay-bundle.test.ts` が担保する）。
 * 推論内容（本文・応答）は転送と `usage` の読み取りにだけ使い、保存もログ
 * 出力もしない（クリティカル設計決定 6）。
 */

/** 上流へ送る Anthropic の API の版（Rust の `ANTHROPIC_VERSION` と同じ値）。 */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 上流の応答から中継がアプリへ通すヘッダ（クリティカル設計決定 2）。 */
const PASSED_RESPONSE_HEADERS = ["content-type", "retry-after", "request-id"] as const;

/** 同時要求数の上限の 429 に付ける `retry-after`（秒。仮定 A11）。 */
const CONCURRENCY_RETRY_AFTER_SECONDS = 1;

export interface RelayDeps {
  config: RelayConfig;
  /** 事業者の API キー（秘密情報。応答・ログ・利用量の記録に出さない）。 */
  operatorKey: string;
  authenticate: Authenticate;
  usageStore: UsageStore;
  upstreamFetch: UpstreamFetch;
  now: () => Date;
  logger: RelayLogger;
}

/**
 * 中継の Hono のアプリを組み立てる。設定が不正（既定モデルが許可リストに
 * 無い・上限や重みが負 等）なら例外を投げる。
 */
export function createRelayApp(deps: RelayDeps): Hono {
  const model = validateRelayConfig(deps.config);
  if (typeof deps.operatorKey !== "string" || deps.operatorKey.length === 0) {
    throw new RelayConfigError("operatorKey must be a non-empty string");
  }
  try {
    // ヘッダに使えない文字（改行・Latin-1 の外の文字等）を含むキーは、要求の
    // たびに（予約の後で）例外になるため、組み立ての時点で弾く。
    new Headers({ "x-api-key": deps.operatorKey });
  } catch {
    throw new RelayConfigError("operatorKey is not a valid header value");
  }
  const limits: ReserveRequest["limits"] = {
    daily: scaledUnits(deps.config.dailyLimit),
    monthly: scaledUnits(deps.config.monthlyLimit),
    maxConcurrent: deps.config.maxConcurrentRequests,
  };
  const maxBufferedBytes = deps.config.maxBufferedResponseBytes ?? DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  const app = new Hono();
  app.post("/v1/messages", (c) => handleMessages(deps, model, limits, maxBufferedBytes, c.req.raw));
  app.onError(() => {
    // 例外の中身（message・stack）は出さない。種類だけを記録する。
    safeLog(deps.logger, { event: "internal_error", status: 500, errorType: "api_error" });
    return relayErrorResponse(500, "api_error");
  });
  return app;
}

/** ログのポートの失敗で、転送・精算を止めない（精算の正しさをログの副作用に依存させない）。 */
function safeLog(logger: RelayLogger, record: RelayLogRecord): void {
  try {
    logger.log(record);
  } catch {
    // 記録できなくても続ける。
  }
}

function parseBearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer +(\S+) *$/i);
  return match ? match[1] : null;
}

type BodyReadResult = { tooLarge: true } | { tooLarge: false; bytes: Uint8Array };

/** 本文を上限のバイト数まで読む。超えた時点で読むのをやめる（全部を溜めない）。 */
async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyReadResult> {
  if (!body) {
    return { tooLarge: false, bytes: new Uint8Array() };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, bytes };
}

function parseJsonBody(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    // 例外の message には本文の断片が入りうるため、捨てる。
    return { ok: false };
  }
}

function passedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
}

/** 本文を持てないステータス（`Response` の生成で例外になる）。 */
function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

async function handleMessages(
  deps: RelayDeps,
  model: RelayModel,
  limits: ReserveRequest["limits"],
  maxBufferedBytes: number,
  request: Request,
): Promise<Response> {
  const { config, logger } = deps;
  const startedAt = deps.now();

  const reject = (
    status: number,
    type: RelayErrorType,
    accountId?: string,
    options?: Parameters<typeof relayErrorResponse>[2],
  ): Response => {
    safeLog(logger, { event: "rejected", accountId, status, errorType: type });
    return relayErrorResponse(status, type, options);
  };

  // (1) 認証
  const token = parseBearerToken(request.headers.get("authorization"));
  const accountId = token === null ? null : await deps.authenticate(token);
  if (accountId === null) {
    return reject(401, "authentication_error");
  }

  // (2) 入力量の上限（JSON の解釈より前）
  const body = await readBodyWithLimit(request.body, config.maxRequestBytes);
  if (body.tooLarge) {
    return reject(413, "request_too_large", accountId);
  }

  // (3) JSON の解釈と項目の検査
  const parsed = parseJsonBody(body.bytes);
  const validation = parsed.ok ? validateMessagesRequest(parsed.value, config.maxTokensCap) : null;
  if (!validation?.ok) {
    return reject(400, "invalid_request_error", accountId);
  }

  // (4) 既定モデルの解決と書き換え。上流へは検査した値を組み立て直して送る
  // （元の本文をそのまま送らない——重複した項目等で、検査した値と送る値が
  // 食い違わないようにする）。
  const forwardedBody = JSON.stringify(rewriteForModel(validation.request, model));
  const forwardedBytes = new TextEncoder().encode(forwardedBody).byteLength;

  // (5) 送信前の予約。入力の見積もりは元の本文のバイト数（仮定 A10）と、
  // 組み立て直した本文のバイト数の大きいほう（数値の表記の展開等で、送る本文
  // のほうが大きくなっても見積もりが下回らないようにする）。
  // 期間キーと期限は予約の直前の時刻から求める（要求の受け付けの時刻を使うと、
  // UTC の日・月の境界の前に要求を開き、境界の後に本文を送り終えることで、
  // 旧期間の枠で新期間を消費できてしまう。PR #638 の Codex の指摘）。
  const reservedAt = deps.now();
  const { dayKey, monthKey } = periodKeys(reservedAt);
  const reservedUnits = maxCostUnits(
    Math.max(body.bytes.byteLength, forwardedBytes),
    validation.request.max_tokens,
    config.inputTokensPerByte,
    model.weights,
  );
  const reservation = await deps.usageStore.reserve({
    accountId,
    dayKey,
    monthKey,
    units: reservedUnits,
    limits,
    expiresAt: new Date(reservedAt.getTime() + config.reservationTtlMs),
  });
  if (!reservation.ok) {
    return reservation.reason === "concurrency"
      ? reject(429, "rate_limit_error", accountId, { retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS })
      : reject(429, "usage_limit_exceeded", accountId, { limit: reservation.reason });
  }

  // (6)(7) 上流への転送と精算
  const reservationId = reservation.reservationId;
  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  request.signal.addEventListener("abort", abortUpstream);

  // 精算は 1 回だけ行う。利用量のポートの書き込みを待ってから応答を終える
  // （書き込みの前に応答が終わると、実行基盤によっては書き込みが打ち切られ、
  // 直後の要求が未精算の予約で拒否されうる）。
  let settlement: Promise<void> | undefined;
  const settle = (status: number, outcome: SettleOutcome): Promise<void> => {
    settlement ??= (async () => {
      request.signal.removeEventListener("abort", abortUpstream);
      try {
        await deps.usageStore.settle(reservationId, outcome);
      } catch {
        // 孤立した予約は期限で予約額に確定する（回収と再試行は S3）。
        safeLog(logger, { event: "settle_failed", accountId, errorType: "settle_failed" });
        return;
      }
      const units = outcome.type === "actual" ? outcome.units : outcome.type === "reserved" ? reservedUnits : 0;
      safeLog(logger, {
        event: "completed",
        accountId,
        status,
        model: model.id,
        settlement: outcome.type,
        units,
        ...(outcome.type === "actual"
          ? {
              inputTokens: outcome.inputTokens,
              outputTokens: outcome.outputTokens,
              cacheReadInputTokens: outcome.cacheReadInputTokens,
              cacheCreationInputTokens: outcome.cacheCreationInputTokens,
            }
          : {}),
        durationMs: deps.now().getTime() - startedAt.getTime(),
      });
    })();
    return settlement;
  };
  const settleWithUsage = (status: number, usage: TokenUsage | null): Promise<void> =>
    settle(status, usage ? { type: "actual", units: costUnits(usage, model.weights), ...usage } : { type: "reserved" });

  // 予約の後に想定外の例外が起きても予約を残さない。上流を呼ぶ前なら解放し、
  // 呼んだ後なら予約額で確定してから投げ直す（精算済みなら何もしない）。
  let upstreamCalled = false;
  try {
    if (request.signal.aborted) {
      // 上流へ送る前にアプリが中止した（課金されない）。
      await settle(502, { type: "release" });
      return relayErrorResponse(502, "api_error");
    }

    const upstreamRequest = new Request(config.upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.operatorKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: forwardedBody,
    });

    let upstream: Response;
    upstreamCalled = true;
    try {
      upstream = await deps.upstreamFetch(upstreamRequest, upstreamAbort.signal);
    } catch (error) {
      // 送る前の失敗だけが確定的に課金されない。それ以外（区分の無い例外・
      // 応答ヘッダの前のアプリの中止を含む）は予約額で確定する（安全側）。
      const sentBeforeFailure = !(error instanceof UpstreamFailure && error.phase === "before-send");
      await settle(502, sentBeforeFailure ? { type: "reserved" } : { type: "release" });
      return relayErrorResponse(502, "api_error");
    }

    const status = upstream.status;
    if (upstream.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      // 上流へのリダイレクトには従わない（`createFetchUpstream` は
      // `redirect: "manual"`）。上流の URL が変わったことを示すだけで要求は
      // 処理されていないため、予約を解放し、`location` を通さず上流の失敗にする。
      upstream.body?.cancel().catch(() => undefined);
      await settle(502, { type: "release" });
      return relayErrorResponse(502, "api_error");
    }

    const headers = passedResponseHeaders(upstream.headers);
    if (status < 200 || status >= 300) {
      // 上流が応答を返した 2xx 以外は確定的に課金されない。本文は加工せずに返す。
      await settle(status, { type: "release" });
      return new Response(isNullBodyStatus(status) ? null : upstream.body, { status, headers });
    }

    const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const meter = isEventStream ? createSseUsageMeter() : createJsonUsageMeter(maxBufferedBytes);
    if (!upstream.body || isNullBodyStatus(status)) {
      await settleWithUsage(status, null);
      return new Response(null, { status, headers });
    }

    const reader = upstream.body.getReader();
    let cancelled = false;
    // アプリがまだ読んでいない断片の待ち行列をバイト数で数える（`desiredSize` が
    // 「上限 − 待ち行列のバイト数」になる）。
    const queuingStrategy: QueuingStrategy<Uint8Array> = {
      highWaterMark: maxBufferedBytes,
      size: (chunk) => chunk.byteLength,
    };
    const relayed = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          // 上流を、アプリの読み取りを待たずに最後まで読む（精算を上流の終わりに
          // 合わせ、読み取りの遅いアプリが精算を遅らせないようにする）。断片は
          // 受けたそばからアプリへ流す。アプリが読むより速く届いた断片は、この
          // ストリームの内部の待ち行列に残る。待ち行列が `maxBufferedBytes` を
          // 超えたら（読まないアプリ）、アプリの中止と同じ扱いで上流を止める（#641）。
          void (async () => {
            let upstreamFailed = false;
            let overflowed = false;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                meter.push(value);
                if (cancelled) continue;
                controller.enqueue(value);
                if ((controller.desiredSize ?? 0) < 0) {
                  overflowed = true;
                  upstreamAbort.abort();
                  reader.cancel().catch(() => undefined);
                  break;
                }
              }
            } catch {
              // 上流との接続が切れた・アプリが中止した。終端の `usage` を受け取って
              // いなければ、下の精算は予約額で確定する。
              upstreamFailed = true;
            }
            if (overflowed) {
              // 本文・`usage` の中身は記録しない。
              safeLog(logger, { event: "response_buffer_exceeded", accountId, status, errorType: "response_buffer_exceeded" });
            }
            // 中止（アプリの中止・上限の超過）でも、終端の `usage` を受け取って
            // いなければ予約額で確定する（`cancel()` と同じ扱い）。
            await settleWithUsage(status, meter.result());
            if (cancelled) return;
            if (overflowed) {
              // 文言は固定。
              controller.error(new Error("relay response buffer limit exceeded"));
            } else if (upstreamFailed) {
              // ステータスは変えずに、本文を異常終了させる（正常な終わりに
              // 見せない）。文言は固定。
              controller.error(new Error("upstream response ended before completion"));
            } else {
              controller.close();
            }
          })();
        },
        cancel() {
          cancelled = true;
          upstreamAbort.abort();
          reader.cancel().catch(() => undefined);
          return settleWithUsage(status, meter.result());
        },
      },
      queuingStrategy,
    );
    return new Response(relayed, { status, headers });
  } catch (error) {
    await settle(500, upstreamCalled ? { type: "reserved" } : { type: "release" });
    throw error;
  }
}
