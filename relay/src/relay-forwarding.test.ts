import { describe, expect, it } from "vitest";
import { createRelayApp } from "./relay-app.js";
import { RelayConfigError } from "./config.js";
import { createMemoryUsageStore } from "./usage-store.js";
import { createStaticTokenAuthenticator } from "./ports.js";
import {
  HAIKU_9_9,
  TEST_ADAPTIVE,
  TEST_OPERATOR_KEY,
  TOKEN_A,
  UPSTREAM_URL,
  appRequestBody,
  createControlledBody,
  createHarness,
  defaultTestConfig,
  deferred,
  flush,
  jsonResponse,
  messageJson,
  sseResponse,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S1）「既定モデルの解決と要求の書き換え」「転送のヘッダ」
 * 「応答の転送」（クリティカル設計決定 2・3）。
 */

const CHAT_BODY = appRequestBody({
  system: [{ type: "text", text: "system prompt" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "set_task", input: { a: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
  ],
  tools: [{ name: "set_task", description: "d", input_schema: { type: "object", properties: {} } }],
  tool_choice: { type: "auto" },
  thinking: { type: "adaptive" },
  output_config: { effort: "low" },
  max_tokens: 16000,
  stream: false,
});

describe("既定モデルの解決と要求の書き換え", () => {
  it("転送される本文の model は設定の defaultModel のモデル ID", async () => {
    const h = createHarness();
    await h.send(CHAT_BODY);
    expect(h.calls[0].body.model).toBe("claude-haiku-4-5");
  });

  it("defaultModel だけを差し替えた設定では、同じ要求の model が差し替え後の ID になる", async () => {
    const h = createHarness({ config: { defaultModel: HAIKU_9_9.id } });
    await h.send(CHAT_BODY);
    expect(h.calls[0].body.model).toBe("claude-haiku-9-9");
  });

  it("thinking が adaptive なら、既定モデルの行が定める値（disabled）で転送される", async () => {
    const h = createHarness();
    await h.send(CHAT_BODY);
    expect(h.calls[0].body.thinking).toEqual({ type: "disabled" });
  });

  it("output_config が effort だけなら、effort に対応しない行へは output_config ごと取り除く", async () => {
    const h = createHarness();
    await h.send(CHAT_BODY);
    expect(h.calls[0].body).not.toHaveProperty("output_config");
  });

  it("output_config が effort 以外も持つなら、effort だけを取り除く", async () => {
    const h = createHarness();
    const format = { type: "json_schema", schema: { type: "object" } };
    await h.send({ ...CHAT_BODY, output_config: { effort: "low", format } });
    expect(h.calls[0].body.output_config).toEqual({ format });
  });

  it("thinking が disabled の要求はそのまま disabled で送る", async () => {
    const h = createHarness();
    await h.send({ ...CHAT_BODY, thinking: { type: "disabled" } });
    expect(h.calls[0].body.thinking).toEqual({ type: "disabled" });
  });

  it("adaptive と effort に対応する行へ差し替えると、thinking と output_config はアプリの要求と同じ値", async () => {
    const h = createHarness({ config: { defaultModel: TEST_ADAPTIVE.id } });
    await h.send(CHAT_BODY);
    expect(h.calls[0].body.thinking).toEqual({ type: "adaptive" });
    expect(h.calls[0].body.output_config).toEqual({ effort: "low" });
  });

  it.each(["messages", "system", "tools", "tool_choice", "max_tokens", "stream"])(
    "転送される本文の %s はアプリの要求と同じ値",
    async (field) => {
      const h = createHarness();
      await h.send(CHAT_BODY);
      expect(h.calls[0].body[field]).toEqual(CHAT_BODY[field]);
    },
  );

  it("上流の URL は設定の upstreamUrl で、POST で送る", async () => {
    const h = createHarness();
    await h.send(CHAT_BODY);
    expect(h.calls[0].request.url).toBe(UPSTREAM_URL);
    expect(h.calls[0].request.method).toBe("POST");
  });
});

describe("設定の検証", () => {
  function build(overrides: Parameters<typeof defaultTestConfig>[0], operatorKey = TEST_OPERATOR_KEY) {
    return () =>
      createRelayApp({
        config: defaultTestConfig(overrides),
        operatorKey,
        authenticate: createStaticTokenAuthenticator(new Map()),
        usageStore: createMemoryUsageStore(),
        upstreamFetch: async () => jsonResponse({}),
        now: () => new Date(),
        logger: { log: () => undefined },
      });
  }

  it("defaultModel が許可リストに無い設定では例外を投げる", () => {
    expect(build({ defaultModel: "claude-opus-5-5" })).toThrow(RelayConfigError);
  });

  it.each([
    ["dailyLimit が負", { dailyLimit: -1 }],
    ["monthlyLimit が負", { monthlyLimit: -0.01 }],
    ["重みが負", { models: [{ ...HAIKU_9_9, id: "claude-haiku-4-5", weights: { input: -1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }] }],
    ["maxTokensCap が 0", { maxTokensCap: 0 }],
    ["maxRequestBytes が 0", { maxRequestBytes: 0 }],
    ["inputTokensPerByte が 0", { inputTokensPerByte: 0 }],
    ["maxConcurrentRequests が 0", { maxConcurrentRequests: 0 }],
    ["reservationTtlMs が 0", { reservationTtlMs: 0 }],
    ["dailyLimit が NaN", { dailyLimit: Number.NaN }],
    ["upstreamUrl が URL でない", { upstreamUrl: "not a url" }],
    ["upstreamUrl が平文の http", { upstreamUrl: "http://upstream.test/v1/messages" }],
    ["upstreamUrl がユーザー名とパスワードを含む", { upstreamUrl: "https://user:pass@upstream.test/v1/messages" }],
    ["upstreamUrl がユーザー名だけを含む", { upstreamUrl: "https://user@upstream.test/v1/messages" }],
  ])("%s の設定では例外を投げる", (_label, overrides) => {
    expect(build(overrides)).toThrow(RelayConfigError);
  });

  it("上限が 0 の設定は組み立てられる（すべての要求を止める設定）", () => {
    expect(build({ dailyLimit: 0, monthlyLimit: 0 })).not.toThrow();
  });

  it("事業者のキーが空なら例外を投げる", () => {
    expect(build({}, "")).toThrow(RelayConfigError);
  });

  it.each([
    ["改行", "sk-operator\nX-Injected: 1"],
    ["Latin-1 の外の文字", "sk-operator-鍵"],
  ])("事業者のキーがヘッダに使えない文字（%s）を含むなら、組み立ての時点で例外を投げる", (_label, key) => {
    expect(build({}, key)).toThrow(RelayConfigError);
  });

  it.each([
    ["10^-4 刻みでない重み", { models: [{ ...HAIKU_9_9, id: "claude-haiku-4-5", weights: { input: 0.00001, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }] }],
    ["整数表現で数えきれない上限", { dailyLimit: 1e9 }],
  ])("%s の設定では例外を投げる", (_label, overrides) => {
    expect(build(overrides)).toThrow(RelayConfigError);
  });
});

describe("転送のヘッダ", () => {
  async function sendWithAppHeaders() {
    const h = createHarness({
      upstream: () => jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 }), 200, { "request-id": "req_1" }),
    });
    const response = await h.send(CHAT_BODY, {
      headers: {
        "x-api-key": "sk-app-supplied-key",
        "anthropic-version": "2099-01-01",
        "anthropic-beta": "files-api-2025-04-14",
      },
    });
    return { h, response, upstreamHeaders: h.calls[0].request.headers };
  }

  it("上流の x-api-key は設定の事業者のキー（アプリの x-api-key に差し替えられない）", async () => {
    const { upstreamHeaders } = await sendWithAppHeaders();
    expect(upstreamHeaders.get("x-api-key")).toBe(TEST_OPERATOR_KEY);
  });

  it("上流の anthropic-version は 2023-06-01", async () => {
    const { upstreamHeaders } = await sendWithAppHeaders();
    expect(upstreamHeaders.get("anthropic-version")).toBe("2023-06-01");
  });

  it("アプリの authorization のトークンは上流のどのヘッダにも現れない", async () => {
    const { upstreamHeaders } = await sendWithAppHeaders();
    for (const [, value] of upstreamHeaders) {
      expect(value).not.toContain(TOKEN_A);
    }
    expect(upstreamHeaders.has("authorization")).toBe(false);
  });

  it("アプリの anthropic-beta は上流へ渡らない", async () => {
    const { upstreamHeaders } = await sendWithAppHeaders();
    expect(upstreamHeaders.has("anthropic-beta")).toBe(false);
  });

  it("事業者のキーはアプリへの応答のヘッダにも本文にも現れない", async () => {
    const { response } = await sendWithAppHeaders();
    for (const [, value] of response.headers) {
      expect(value).not.toContain(TEST_OPERATOR_KEY);
    }
    expect(await response.text()).not.toContain(TEST_OPERATOR_KEY);
  });
});

describe("応答の転送", () => {
  it("上流の非ストリーミングの 200 の本文は変わらずに返る", async () => {
    const upstreamText = JSON.stringify(messageJson({ input_tokens: 3, output_tokens: 4 }, "応答の本文"));
    const h = createHarness({
      upstream: () => new Response(upstreamText, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const response = await h.send(CHAT_BODY);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(upstreamText);
  });

  it("上流の 529 はステータスと本文が変わらずに返る", async () => {
    const upstreamText = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const h = createHarness({
      upstream: () => new Response(upstreamText, { status: 529, headers: { "content-type": "application/json" } }),
    });
    const response = await h.send(CHAT_BODY);
    expect(response.status).toBe(529);
    expect(await response.text()).toBe(upstreamText);
  });

  it("上流の 429 の retry-after は同じ値で付き、content-type・retry-after・request-id 以外のヘッダは付かない", async () => {
    const h = createHarness({
      upstream: () =>
        jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "x" } }, 429, {
          "retry-after": "17",
          "request-id": "req_9",
          "set-cookie": "session=abc",
          "anthropic-ratelimit-requests-remaining": "0",
        }),
    });
    const response = await h.send(CHAT_BODY);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("request-id")).toBe("req_9");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect([...response.headers.keys()].sort()).toEqual(["content-type", "request-id", "retry-after"]);
  });

  it("上流の 200 の応答でも、許可した 3 つ以外のヘッダは付かない", async () => {
    const h = createHarness({
      upstream: () => jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 }), 200, { "set-cookie": "a=b" }),
    });
    const response = await h.send(CHAT_BODY);
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("上流のポートが例外を投げると 502", async () => {
    const h = createHarness({
      upstream: () => {
        throw new TypeError("network down");
      },
    });
    const response = await h.send(CHAT_BODY);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).not.toContain("network down");
  });

  it("ストリーミングで、上流が 2 つ目の断片を返す前に、アプリは最初の断片を受け取れる", async () => {
    const h = createHarness();
    const upstreamBody = createControlledBody();
    h.setUpstream(() => sseResponse(upstreamBody.stream));
    const response = await h.send({ ...CHAT_BODY, stream: true });
    const reader = response.body!.getReader();
    const first = 'event: ping\ndata: {"type":"ping"}\n\n';
    upstreamBody.push(first);
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(first);
    upstreamBody.close();
    expect((await reader.read()).done).toBe(true);
  });

  it("ストリーミングでアプリが受け取るバイト列の連結は、上流のバイト列の連結と一致する", async () => {
    const h = createHarness();
    const upstreamBody = createControlledBody();
    h.setUpstream(() => sseResponse(upstreamBody.stream));
    const responsePromise = h.send({ ...CHAT_BODY, stream: true });
    await flush();
    // 多バイト文字を断片の境界で分割する。
    const encoded = new TextEncoder().encode('event: x\ndata: {"t":"日本語"}\n\n');
    const chunks = [encoded.slice(0, 20), encoded.slice(20, 21), encoded.slice(21)];
    const response = await responsePromise;
    const received = response.arrayBuffer();
    for (const chunk of chunks) {
      upstreamBody.push(chunk);
    }
    upstreamBody.close();
    expect(new Uint8Array(await received)).toEqual(encoded);
  });

  it("ストリーミングの応答の途中でアプリが中止すると、上流へ渡した AbortSignal が中止になる", async () => {
    const h = createHarness();
    const signals: AbortSignal[] = [];
    h.setUpstream((call) => {
      signals.push(call.signal);
      const body = createControlledBody(call.signal);
      body.push(sseTranscriptStart());
      return sseResponse(body.stream);
    });
    const response = await h.send({ ...CHAT_BODY, stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    expect(signals[0].aborted).toBe(false);
    await reader.cancel();
    expect(signals[0].aborted).toBe(true);
  });

  it("応答ヘッダの前にアプリが要求を中止すると、上流へ渡した AbortSignal が中止になる", async () => {
    const h = createHarness();
    const pending = deferred<Response>();
    h.setUpstream((call) => {
      call.signal.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")));
      return pending.promise;
    });
    const app = new AbortController();
    const responsePromise = h.send(CHAT_BODY, { signal: app.signal });
    await flush();
    expect(h.calls[0].signal.aborted).toBe(false);
    app.abort();
    await responsePromise;
    expect(h.calls[0].signal.aborted).toBe(true);
  });
});

function sseTranscriptStart(): string {
  return 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n';
}
