import { createRelayApp } from "../relay-app.js";
import type { RelayConfig, RelayModel } from "../config.js";
import { createStaticTokenAuthenticator, type RelayLogRecord, type UpstreamFetch } from "../ports.js";
import { PLAN_DEFAULT_MODEL } from "../request-validation.js";
import { createMemoryUsageStore, type MemoryUsageStore } from "../usage-store.js";

/**
 * 中継のテストの共通の組み立て（機能仕様「受入基準（S1）」の「既定のテスト
 * 設定」）。上流・時刻・認証はすべて模擬で、実 API は呼ばない。
 */

export const TEST_OPERATOR_KEY = "sk-operator-TEST-KEY-7d1f";
export const TOKEN_A = "app-token-AAAA-1111";
export const TOKEN_B = "app-token-BBBB-2222";
export const ACCOUNT_A = "account-a";
export const ACCOUNT_B = "account-b";
export const UPSTREAM_URL = "https://upstream.test/v1/messages";
export const RELAY_URL = "http://relay.test/v1/messages";

const HAIKU_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

export const HAIKU_4_5: RelayModel = {
  id: "claude-haiku-4-5",
  weights: HAIKU_WEIGHTS,
  adaptiveThinkingReplacement: { type: "disabled" },
  supportsEffort: false,
};

export const HAIKU_9_9: RelayModel = { ...HAIKU_4_5, id: "claude-haiku-9-9" };

/** adaptive thinking と effort に対応する架空の行（書き換えなし）。 */
export const TEST_ADAPTIVE: RelayModel = { id: "claude-test-adaptive", weights: HAIKU_WEIGHTS, supportsEffort: true };

const LARGE = 1_000_000_000;

export function defaultTestConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    upstreamUrl: UPSTREAM_URL,
    defaultModel: HAIKU_4_5.id,
    models: [HAIKU_4_5, HAIKU_9_9, TEST_ADAPTIVE],
    maxTokensCap: LARGE,
    maxRequestBytes: LARGE,
    inputTokensPerByte: 1,
    dailyLimit: LARGE,
    monthlyLimit: LARGE,
    maxConcurrentRequests: LARGE,
    reservationTtlMs: 600_000,
    ...overrides,
  };
}

/** アプリが送る典型的な要求本文（#581 S2 の変換器の最上位の項目の形）。 */
export function appRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: PLAN_DEFAULT_MODEL,
    max_tokens: 1000,
    system: "You are the boss.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 模擬の上流
// ---------------------------------------------------------------------------

export interface UpstreamCall {
  request: Request;
  bodyText: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

export type UpstreamHandler = (call: UpstreamCall) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function messageJson(usage: Record<string, number>, text = "ok"): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: HAIKU_4_5.id,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage,
  };
}

export function sseEvent(data: Record<string, unknown>): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 終端（`message_stop`）まである SSE の本文。 */
export function sseTranscript(options: {
  inputTokens: number;
  outputTokens: number[];
  text?: string;
  terminal?: boolean;
}): string[] {
  const events = [
    sseEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: options.inputTokens, output_tokens: 1 } } }),
    sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: options.text ?? "hi" } }),
    sseEvent({ type: "content_block_stop", index: 0 }),
    ...options.outputTokens.map((outputTokens) =>
      sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } }),
    ),
  ];
  if (options.terminal !== false) {
    events.push(sseEvent({ type: "message_stop" }));
  }
  return events;
}

export function sseResponse(body: ReadableStream<Uint8Array> | string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/**
 * 断片を 1 つずつ押し込める上流の本文。`signal` が中止されたら、実際の
 * `fetch` と同じく本文の読み取りを失敗させる。
 */
export function createControlledBody(signal?: AbortSignal) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      controller.error(new DOMException("aborted", "AbortError"));
    } catch {
      // すでに閉じている
    }
  });
  return {
    stream,
    push(chunk: string | Uint8Array) {
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    close() {
      controller.close();
    },
    fail() {
      controller.error(new TypeError("connection reset"));
    },
  };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスク・タイマーを流して、非同期の処理を進める。 */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// 中継の組み立て
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  config?: Partial<RelayConfig>;
  upstream?: UpstreamHandler;
  now?: Date;
}

export interface SendOptions {
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function createHarness(options: HarnessOptions = {}) {
  const store: MemoryUsageStore = createMemoryUsageStore();
  const logs: RelayLogRecord[] = [];
  const calls: UpstreamCall[] = [];
  const clock = { current: options.now ?? new Date("2026-09-15T12:00:00Z") };
  let handler: UpstreamHandler = options.upstream ?? (() => jsonResponse(messageJson({ input_tokens: 10, output_tokens: 5 })));

  const upstreamFetch: UpstreamFetch = async (request, signal) => {
    const bodyText = await request.clone().text();
    const call: UpstreamCall = { request, bodyText, body: JSON.parse(bodyText), signal };
    calls.push(call);
    return handler(call);
  };

  const app = createRelayApp({
    config: defaultTestConfig(options.config),
    operatorKey: TEST_OPERATOR_KEY,
    authenticate: createStaticTokenAuthenticator(
      new Map([
        [TOKEN_A, ACCOUNT_A],
        [TOKEN_B, ACCOUNT_B],
      ]),
    ),
    usageStore: store,
    upstreamFetch,
    now: () => clock.current,
    logger: { log: (record) => logs.push(record) },
  });

  async function send(body: unknown, sendOptions: SendOptions = {}): Promise<Response> {
    const token = sendOptions.token === undefined ? TOKEN_A : sendOptions.token;
    const headers: Record<string, string> = { "content-type": "application/json", ...sendOptions.headers };
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    return app.request(
      new Request(RELAY_URL, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
        signal: sendOptions.signal,
      }),
    );
  }

  return {
    app,
    store,
    logs,
    calls,
    clock,
    send,
    setUpstream(next: UpstreamHandler) {
      handler = next;
    },
    /** 時計の現在時刻の期間キーでの、そのアカウントの利用量。 */
    usage(accountId = ACCOUNT_A) {
      const { dayKey, monthKey } = {
        dayKey: clock.current.toISOString().slice(0, 10),
        monthKey: clock.current.toISOString().slice(0, 7),
      };
      return store.get(accountId, dayKey, monthKey);
    },
  };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 既定のテスト設定での予約額 `(ceil(B × 1) × 1.25 + M × 5) ÷ 1,000,000`。 */
export function expectedReservedUnits(bodyText: string, maxTokens: number): number {
  return (Math.ceil(byteLength(bodyText) * 1) * 1.25 + maxTokens * 5) / 1_000_000;
}
