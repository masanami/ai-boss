import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeClient, requestVerdict, streamBossMessage } from "../claude-client.js";
import {
  getLlmBackendImplementation,
  registeredLlmBackendNames,
  resetLlmBackendRegistryForTest,
  type ResolvedLlmRequest,
} from "../llm-backend-registry.js";
import {
  RELAY_MESSAGES_DESTINATION,
  SecureTransportError,
  type SecureTransportPort,
  type SecureTransportResponse,
  type SecureTransportSendRequest,
} from "../secure-transport-port.js";
import { RelayUsageLimitError } from "../relay-usage-limit.js";
import { AnthropicMessagesHttpError, classifyByokAnthropicError, registerByokAnthropicBackend } from "./byok-anthropic-backend.js";
import {
  PLAN_DEFAULT_MODEL_ID,
  RELAY_BACKEND,
  RELAY_ERROR_BODY_LIMIT_BYTES,
  RelayHttpError,
  RelayPlanModelRequiredError,
  classifyRelayError,
  registerRelayBackend,
} from "./relay-backend.js";

/**
 * LLM 中継（`relay`）バックエンドの受入基準（機能仕様 docs/features/llm-relay-server.md
 * 受入基準（S2）S2-B・S2-C・S2-F）。転送のポートは常に模擬（実 API・実中継は呼ばない）。
 */

interface CapturedCall {
  request: SecureTransportSendRequest;
  signal: AbortSignal;
}

function makeTransport(
  respond: (call: CapturedCall, callIndex: number) => SecureTransportResponse | Promise<SecureTransportResponse>,
): { transport: SecureTransportPort; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const transport: SecureTransportPort = async (request, signal) => {
    const call = { request, signal };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { transport, calls };
}

function asyncBody(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

const encode = (text: string) => new TextEncoder().encode(text);
const textBody = (text: string) => asyncBody([encode(text)]);

/** `return` の呼び出しを観測できる本文（反復子を手で組む）。 */
function trackedBody(chunks: Uint8Array[]): { body: AsyncIterable<Uint8Array>; returned: () => number; pulled: () => number } {
  let returned = 0;
  let pulled = 0;
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          pulled += 1;
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
        async return() {
          returned += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { body, returned: () => returned, pulled: () => pulled };
}

const sseEventText = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const buildSseText = (events: Record<string, unknown>[]) => events.map(sseEventText).join("");

function textStreamEvents(textDeltas: string[]): Record<string, unknown>[] {
  return [
    { type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...textDeltas.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

const okResponse = (body: AsyncIterable<Uint8Array>): SecureTransportResponse => ({ status: 200, headers: {}, body });

function errorResponse(
  status: number,
  body: string | Uint8Array,
  headers: SecureTransportResponse["headers"] = {},
): SecureTransportResponse {
  return { status, headers, body: asyncBody([typeof body === "string" ? encode(body) : body]) };
}

const usageLimitBody = (limit?: string) =>
  JSON.stringify({
    type: "error",
    error: { type: "usage_limit_exceeded", message: "BODY-MARKER-limit", ...(limit === undefined ? {} : { limit }) },
  });
const rateLimitBody = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "BODY-MARKER-rate" } });

function planRequest(overrides: Partial<ResolvedLlmRequest> = {}): ResolvedLlmRequest {
  return {
    model: PLAN_DEFAULT_MODEL_ID,
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1024,
    thinking: { type: "disabled" },
    ...overrides,
  };
}

function registerAndGetImpl(transport: SecureTransportPort) {
  registerRelayBackend(transport);
  const impl = getLlmBackendImplementation(RELAY_BACKEND)!;
  return { impl, client: impl.createClient({}) };
}

beforeEach(() => {
  resetLlmBackendRegistryForTest();
});
afterEach(() => {
  resetLlmBackendRegistryForTest();
});

describe("relay の登録と要求（S2-B）", () => {
  it("バックエンドの名前は relay で、registerRelayBackend の後に createClaudeClient(env, 'relay') は env が空でも失敗しない", () => {
    const { transport } = makeTransport(() => okResponse(textBody("")));
    registerRelayBackend(transport);
    expect(RELAY_BACKEND).toBe("relay");
    expect(registeredLlmBackendNames()).toEqual(["relay"]);
    expect(() => createClaudeClient({}, "relay")).not.toThrow();
  });

  it("宣言する能力は byok-anthropic が宣言する能力と同じ（ツールループを回さない・toolChoice 対応・長さ制限可）", () => {
    const { transport } = makeTransport(() => okResponse(textBody("")));
    registerRelayBackend(transport);
    registerByokAnthropicBackend(transport);
    const relay = getLlmBackendImplementation("relay")!.capabilities;
    expect(relay).toEqual(getLlmBackendImplementation("byok-anthropic")!.capabilities);
    expect(relay).toEqual({ runsOwnToolLoop: false, supportsToolChoice: true, limitsResponseLength: true });
  });

  it("送ると、ポートに渡る宛先の名前は relay-messages である（ストリーミング・非ストリーミング）", async () => {
    const { transport, calls } = makeTransport(() => okResponse(textBody(buildSseText(textStreamEvents(["ok"])))));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, planRequest(), {}, new AbortController().signal);
    const nonStreaming = makeTransport(() => okResponse(textBody(JSON.stringify({ content: [{ type: "text", text: "ok" }] }))));
    resetLlmBackendRegistryForTest();
    const second = registerAndGetImpl(nonStreaming.transport);
    await second.impl.createRound(second.client, planRequest(), new AbortController().signal);
    expect(RELAY_MESSAGES_DESTINATION).toBe("relay-messages");
    expect(calls.map((call) => call.request.destination)).toEqual(["relay-messages"]);
    expect(nonStreaming.calls.map((call) => call.request.destination)).toEqual(["relay-messages"]);
  });

  it("要求本文の model はプラン込みの既定の値 ai-boss-plan-default である", async () => {
    const { transport, calls } = makeTransport(() => okResponse(textBody(buildSseText(textStreamEvents(["ok"])))));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, planRequest(), {}, new AbortController().signal);
    expect(PLAN_DEFAULT_MODEL_ID).toBe("ai-boss-plan-default");
    expect(JSON.parse(calls[0].request.body).model).toBe("ai-boss-plan-default");
  });

  it("同じ ResolvedLlmRequest（model だけ各バックエンドの値）を relay と byok-anthropic に渡すと、要求本文は model を除いて一致する", async () => {
    const full: Partial<ResolvedLlmRequest> = {
      system: "あなたはボスだ",
      tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "t" },
      thinking: { type: "enabled", budget_tokens: 2048 },
      outputConfig: { effort: "low" },
    };
    for (const stream of [true, false]) {
      resetLlmBackendRegistryForTest();
      const responseText = stream
        ? buildSseText(textStreamEvents(["ok"]))
        : JSON.stringify({ content: [{ type: "text", text: "ok" }] });
      const relay = makeTransport(() => okResponse(textBody(responseText)));
      registerRelayBackend(relay.transport);
      const byok = makeTransport(() => okResponse(textBody(responseText)));
      registerByokAnthropicBackend(byok.transport);
      const run = async (name: "relay" | "byok-anthropic", model: string) => {
        const impl = getLlmBackendImplementation(name)!;
        const client = impl.createClient({});
        const request = planRequest({ ...full, model });
        if (stream) {
          await impl.streamRound(client, request, {}, new AbortController().signal);
        } else {
          await impl.createRound(client, request, new AbortController().signal);
        }
      };
      await run("relay", PLAN_DEFAULT_MODEL_ID);
      await run("byok-anthropic", "claude-sonnet-5");
      const relayBody = JSON.parse(relay.calls[0].request.body) as Record<string, unknown>;
      const byokBody = JSON.parse(byok.calls[0].request.body) as Record<string, unknown>;
      expect(Object.keys(relayBody).sort()).toEqual(Object.keys(byokBody).sort());
      expect(Object.keys(relayBody).sort()).toEqual(
        ["max_tokens", "messages", "model", "output_config", "stream", "system", "thinking", "tool_choice", "tools"].sort(),
      );
      expect({ ...relayBody, model: undefined }).toEqual({ ...byokBody, model: undefined });
    }
  });

  it("model がプラン込みの既定の値でない要求は、転送のポートを呼ばずに再試行不可の失敗にする", async () => {
    const { transport, calls } = makeTransport(() => okResponse(textBody("")));
    const { impl, client } = registerAndGetImpl(transport);
    for (const model of ["claude-haiku-4-5", "claude-sonnet-5", "", "AI-BOSS-PLAN-DEFAULT"]) {
      const stream = impl.streamRound(client, planRequest({ model }), {}, new AbortController().signal);
      await expect(stream).rejects.toBeInstanceOf(RelayPlanModelRequiredError);
      const create = impl.createRound(client, planRequest({ model }), new AbortController().signal);
      await expect(create).rejects.toBeInstanceOf(RelayPlanModelRequiredError);
      expect(classifyRelayError(new RelayPlanModelRequiredError())).toEqual({ retryable: false });
    }
    expect(calls).toHaveLength(0);
  });

  it("ストリーミングで、最初の text_delta の断片を返し次の断片を返す前の時点で onTextDelta はその差分を受けている", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const events = textStreamEvents(["first", "second"]);
    const firstPart = buildSseText(events.slice(0, 3));
    const secondPart = buildSseText(events.slice(3));
    const body: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        yield encode(firstPart);
        await secondGate;
        yield encode(secondPart);
      },
    };
    const { transport } = makeTransport(() => okResponse(body));
    const { impl, client } = registerAndGetImpl(transport);
    const seen: string[] = [];
    const promise = impl.streamRound(client, planRequest(), { onTextDelta: (d) => seen.push(d) }, new AbortController().signal);
    await vi.waitFor(() => expect(seen).toEqual(["first"]));
    releaseSecond();
    const message = await promise;
    expect(seen).toEqual(["first", "second"]);
    expect(message.content).toEqual([{ type: "text", text: "firstsecond" }]);
  });

  it("ストリーミングの tool_use ブロックは、同じ断片の列を byok-anthropic に渡したときと同じツール呼び出しとして解釈される", async () => {
    const events = [
      { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "create_task" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"title":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"買い物"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    const sse = buildSseText(events);
    const relay = makeTransport(() => okResponse(textBody(sse)));
    registerRelayBackend(relay.transport);
    const byok = makeTransport(() => okResponse(textBody(sse)));
    registerByokAnthropicBackend(byok.transport);
    const relayImpl = getLlmBackendImplementation("relay")!;
    const byokImpl = getLlmBackendImplementation("byok-anthropic")!;
    const relayMessage = await relayImpl.streamRound(relayImpl.createClient({}), planRequest(), {}, new AbortController().signal);
    const byokMessage = await byokImpl.streamRound(
      byokImpl.createClient({}),
      planRequest({ model: "claude-sonnet-5" }),
      {},
      new AbortController().signal,
    );
    expect(relayMessage).toEqual(byokMessage);
    expect(relayMessage.content).toEqual([{ type: "tool_use", id: "t1", name: "create_task", input: { title: "買い物" } }]);
  });
});

/** 失敗の値を取り出す（`relay` の 1 回の送信）。 */
async function failureOf(response: SecureTransportResponse): Promise<{ error: unknown; calls: CapturedCall[] }> {
  const { transport, calls } = makeTransport(() => response);
  const { impl, client } = registerAndGetImpl(transport);
  let error: unknown;
  try {
    await impl.createRound(client, planRequest(), new AbortController().signal);
  } catch (caught) {
    error = caught;
  }
  return { error, calls };
}

describe("エラーの分類（S2-C）", () => {
  it("429 usage_limit_exceeded（limit: daily）は再試行不可の RelayUsageLimitError（limit=daily）で、転送のポートは 1 回だけ呼ばれる", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = makeTransport(() => errorResponse(429, usageLimitBody("daily")));
      registerRelayBackend(transport);
      const client = createClaudeClient({}, "relay");
      const promise = streamBossMessage(client, { model: PLAN_DEFAULT_MODEL_ID, messages: [{ role: "user", content: "go" }] });
      const expectation = expect(promise).rejects.toMatchObject({ name: "RelayUsageLimitError", limit: "daily" });
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);
      await expectation;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limit が monthly なら monthly、それ以外・無いときは unknown になる", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["monthly", "monthly"],
      ["weekly", "unknown"],
      ["", "unknown"],
      [undefined, "unknown"],
    ];
    for (const [limit, expected] of cases) {
      resetLlmBackendRegistryForTest();
      const { error } = await failureOf(errorResponse(429, usageLimitBody(limit)));
      expect(error).toBeInstanceOf(RelayUsageLimitError);
      expect((error as RelayUsageLimitError).limit, String(limit)).toBe(expected);
      expect(classifyRelayError(error)).toEqual({ retryable: false });
    }
  });

  it("limit が文字列でない（数値・オブジェクト）ときも unknown になる", async () => {
    for (const limit of [1, { a: 1 }, null, true]) {
      resetLlmBackendRegistryForTest();
      const body = JSON.stringify({ error: { type: "usage_limit_exceeded", limit } });
      const { error } = await failureOf(errorResponse(429, body));
      expect((error as RelayUsageLimitError).limit).toBe("unknown");
    }
  });

  it("429 rate_limit_error・retry-after: 1 は再試行可で、待ち時間は 1 秒である", async () => {
    const { error } = await failureOf(errorResponse(429, rateLimitBody, { "retry-after": "1" }));
    expect(error).toBeInstanceOf(RelayHttpError);
    expect(classifyRelayError(error, new Date())).toEqual({ retryable: true, retryAfterMs: 1000 });
  });

  it("429 rate_limit_error・retry-after なしは再試行可（待ち時間は指定なし）", async () => {
    const { error } = await failureOf(errorResponse(429, rateLimitBody));
    expect(classifyRelayError(error, new Date())).toEqual({ retryable: true, retryAfterMs: undefined });
  });

  it("429 で本文が JSON でない・error.type が無い・error.type が未知の値は、いずれも再試行不可になる", async () => {
    const bodies = [
      "not json",
      "",
      "{}",
      "null",
      "[]",
      JSON.stringify({ error: {} }),
      JSON.stringify({ error: "usage_limit_exceeded" }),
      JSON.stringify({ error: { type: "overloaded_error" } }),
      JSON.stringify({ error: { type: "USAGE_LIMIT_EXCEEDED" } }),
      JSON.stringify({ error: { type: 429 } }),
    ];
    for (const body of bodies) {
      resetLlmBackendRegistryForTest();
      const { error } = await failureOf(errorResponse(429, body, { "retry-after": "1" }));
      expect(error, body).toBeInstanceOf(RelayHttpError);
      expect(classifyRelayError(error, new Date()), body).toEqual({ retryable: false });
    }
  });

  it("429 でも、本文が読めない（本文の読み取りが失敗する）ときは再試行不可になる", async () => {
    const body: AsyncIterable<Uint8Array> = {
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new SecureTransportError("connection");
      },
    };
    const { error } = await failureOf({ status: 429, headers: { "retry-after": "1" }, body });
    expect(error).toBeInstanceOf(RelayHttpError);
    expect(classifyRelayError(error, new Date())).toEqual({ retryable: false });
  });

  it("本文が 65,536 バイトちょうどの有効な JSON の rate_limit_error は再試行可、1 バイト超えたら種類不明（先頭が rate_limit_error の JSON でも）で再試行不可", async () => {
    expect(RELAY_ERROR_BODY_LIMIT_BYTES).toBe(65_536);
    const prefix = '{"error":{"type":"rate_limit_error"},"pad":"';
    const suffix = '"}';
    const padLength = RELAY_ERROR_BODY_LIMIT_BYTES - prefix.length - suffix.length;
    const exact = prefix + "a".repeat(padLength) + suffix;
    expect(encode(exact).byteLength).toBe(65_536);
    const over = prefix + "a".repeat(padLength + 1) + suffix;
    expect(encode(over).byteLength).toBe(65_537);

    const exactResult = await failureOf(errorResponse(429, exact));
    expect(classifyRelayError(exactResult.error, new Date())).toMatchObject({ retryable: true });

    resetLlmBackendRegistryForTest();
    const overResult = await failureOf(errorResponse(429, over));
    expect(classifyRelayError(overResult.error, new Date())).toEqual({ retryable: false });
  });

  it("上限は複数の断片にまたがっても数える（断片の合計が 65,536 を超えたら種類不明）", async () => {
    const half = encode('{"error":{"type":"rate_limit_error"},"pad":"' + "a".repeat(32_800));
    const rest = encode("a".repeat(32_800) + '"}');
    const result = await failureOf({ status: 429, headers: {}, body: asyncBody([half, rest]) });
    expect(classifyRelayError(result.error, new Date())).toEqual({ retryable: false });
  });

  it("429 以外の HTTP のステータスは、401・403・413 が再試行不可、408・500・502・529 が再試行可である", async () => {
    for (const [status, retryable] of [
      [401, false],
      [403, false],
      [413, false],
      [400, false],
      [408, true],
      [500, true],
      [502, true],
      [529, true],
    ] as const) {
      resetLlmBackendRegistryForTest();
      const { error } = await failureOf(errorResponse(status, JSON.stringify({ error: { type: "api_error" } })));
      expect(error, String(status)).toBeInstanceOf(AnthropicMessagesHttpError);
      expect((error as AnthropicMessagesHttpError).status).toBe(status);
      expect(classifyRelayError(error, new Date()).retryable, String(status)).toBe(retryable);
    }
  });

  it("429 以外のステータスの本文の error.type が usage_limit_exceeded でも上限到達にはしない（429 だけが対象）", async () => {
    const { error } = await failureOf(errorResponse(500, usageLimitBody("daily")));
    expect(error).not.toBeInstanceOf(RelayUsageLimitError);
    expect(classifyRelayError(error, new Date()).retryable).toBe(true);
  });

  it("転送の失敗は、connection が再試行可、key-not-registered・unknown-destination が再試行不可である", () => {
    expect(classifyRelayError(new SecureTransportError("connection"))).toEqual({ retryable: true });
    for (const kind of ["key-not-registered", "unknown-destination", "key-store-failure", "invalid-header", "cancelled", "redirect-refused", "duplicate-request-id"] as const) {
      expect(classifyRelayError(new SecureTransportError(kind)), kind).toEqual({ retryable: false });
    }
  });

  it("byok-anthropic は、429 の本文の error.type が usage_limit_exceeded でも本文を読まず、従来どおり再試行可に分類する", async () => {
    const tracked = trackedBody([encode(usageLimitBody("daily"))]);
    const { transport } = makeTransport(() => ({ status: 429, headers: { "retry-after": "1" }, body: tracked.body }));
    registerByokAnthropicBackend(transport);
    const impl = getLlmBackendImplementation("byok-anthropic")!;
    let error: unknown;
    try {
      await impl.createRound(impl.createClient({}), planRequest({ model: "claude-sonnet-5" }), new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnthropicMessagesHttpError);
    expect(error).not.toBeInstanceOf(RelayUsageLimitError);
    expect(classifyByokAnthropicError(error, new Date())).toEqual({ retryable: true, retryAfterMs: 1000 });
    expect(tracked.pulled()).toBe(0);
    expect(tracked.returned()).toBe(1);
  });

  it("失敗の値の message と String(error) に、応答の本文の文字列（目印）が現れない", async () => {
    const markerBodies = [
      usageLimitBody("daily"),
      rateLimitBody,
      JSON.stringify({ error: { type: "api_error", message: "BODY-MARKER-api" } }),
      "BODY-MARKER-not-json",
    ];
    for (const status of [429, 401, 502]) {
      for (const body of markerBodies) {
        resetLlmBackendRegistryForTest();
        const { error } = await failureOf(errorResponse(status, body));
        const text = `${(error as Error).message}|${String(error)}|${JSON.stringify(error)}|${(error as Error).stack?.split("\n")[0]}`;
        expect(text, `${status} ${body.slice(0, 20)}`).not.toContain("BODY-MARKER");
      }
    }
  });

  it("2xx 以外の本文を読み終えた後、本文の反復子の return が呼ばれる", async () => {
    const tracked = trackedBody([encode(rateLimitBody)]);
    const { error } = await failureOf({ status: 429, headers: {}, body: tracked.body });
    expect(error).toBeInstanceOf(RelayHttpError);
    expect(tracked.returned()).toBe(1);
  });

  it("上限で打ち切った後も return が呼ばれ、上限を超えた以降の断片は読まない", async () => {
    const big = new Uint8Array(RELAY_ERROR_BODY_LIMIT_BYTES + 1).fill(0x61);
    const tracked = trackedBody([big, encode("tail-1"), encode("tail-2")]);
    const { error } = await failureOf({ status: 429, headers: {}, body: tracked.body });
    expect(classifyRelayError(error, new Date())).toEqual({ retryable: false });
    expect(tracked.returned()).toBe(1);
    expect(tracked.pulled()).toBe(1);
  });

  it("本文の読み取りが失敗した後も return を呼ぶ（後始末の失敗は元の失敗より優先しない）", async () => {
    let returned = 0;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new SecureTransportError("connection");
          },
          async return() {
            returned += 1;
            throw new Error("cleanup failure");
          },
        };
      },
    };
    const { error } = await failureOf({ status: 502, headers: {}, body });
    expect(error).toBeInstanceOf(AnthropicMessagesHttpError);
    expect((error as AnthropicMessagesHttpError).status).toBe(502);
    expect(returned).toBe(1);
  });
});

describe("自動で切り替えない（S2-F）", () => {
  const failures: Array<{ name: string; respond: () => SecureTransportResponse; fail?: SecureTransportError }> = [
    { name: "429 usage_limit_exceeded", respond: () => errorResponse(429, usageLimitBody("daily")) },
    { name: "429 rate_limit_error", respond: () => errorResponse(429, rateLimitBody) },
    { name: "401", respond: () => errorResponse(401, JSON.stringify({ error: { type: "authentication_error" } })) },
    { name: "502", respond: () => errorResponse(502, JSON.stringify({ error: { type: "api_error" } })) },
    { name: "connection", respond: () => okResponse(textBody("")), fail: new SecureTransportError("connection") },
    { name: "key-not-registered", respond: () => okResponse(textBody("")), fail: new SecureTransportError("key-not-registered") },
  ];

  for (const failure of failures) {
    it(`relay の失敗（${failure.name}）の後、再試行を含め、転送のポートが受けた要求の宛先はすべて relay-messages・model はプラン込みの既定の値`, async () => {
      vi.useFakeTimers();
      try {
        const { transport, calls } = makeTransport(() => {
          if (failure.fail) {
            throw failure.fail;
          }
          return failure.respond();
        });
        registerRelayBackend(transport);
        // BYOK のバックエンドも登録済み（選択とキーが保存済みの状況の代わり）——流れ込まないことを見る。
        const byok = makeTransport(() => okResponse(textBody("")));
        registerByokAnthropicBackend(byok.transport);
        const client = createClaudeClient({}, "relay");
        const promise = requestVerdict(
          client,
          {
            model: PLAN_DEFAULT_MODEL_ID,
            messages: [{ role: "user", content: "go" }],
            tools: [{ name: "v", description: "d", input_schema: { type: "object" } }],
            toolChoice: { type: "tool", name: "v" },
          },
          "v",
          (input) => ({ valid: true, data: input }),
        );
        const settled = promise.then(
          () => "resolved",
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);
        await settled;
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const call of calls) {
          expect(call.request.destination).toBe("relay-messages");
          expect(JSON.parse(call.request.body).model).toBe(PLAN_DEFAULT_MODEL_ID);
        }
        expect(byok.calls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  /** 1 つの失敗を毎回返す relay に `requestVerdict` を投げ、転送のポートが呼ばれた回数と最終的な失敗を返す。 */
  async function attemptsFor(respond: () => SecureTransportResponse): Promise<{ attempts: number; error: unknown }> {
    vi.useFakeTimers();
    try {
      const { transport, calls } = makeTransport(respond);
      registerRelayBackend(transport);
      const client = createClaudeClient({}, "relay");
      const settled = requestVerdict(
        client,
        {
          model: PLAN_DEFAULT_MODEL_ID,
          messages: [{ role: "user", content: "go" }],
          tools: [{ name: "v", description: "d", input_schema: { type: "object" } }],
        },
        "v",
        (input) => ({ valid: true, data: input }),
      ).then(
        () => "resolved" as unknown,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await settled;
      for (const call of calls) {
        expect(call.request.destination).toBe("relay-messages");
      }
      return { attempts: calls.length, error };
    } finally {
      vi.useRealTimers();
      resetLlmBackendRegistryForTest();
    }
  }

  it("再試行可の失敗（429 rate_limit_error・408・500・502・529・connection）は計 3 回送られ、再試行の尽きた後も宛先は relay-messages のまま", async () => {
    const retryable: Array<[string, () => SecureTransportResponse]> = [
      ["429 rate_limit_error", () => errorResponse(429, rateLimitBody, { "retry-after": "1" })],
      ["408", () => errorResponse(408, "{}")],
      ["500", () => errorResponse(500, "{}")],
      ["502", () => errorResponse(502, JSON.stringify({ error: { type: "api_error" } }))],
      ["529", () => errorResponse(529, "{}")],
      [
        "connection",
        () => {
          throw new SecureTransportError("connection");
        },
      ],
    ];
    for (const [label, respond] of retryable) {
      const { attempts } = await attemptsFor(respond);
      expect(attempts, label).toBe(3);
    }
  });

  it("再試行不可の失敗（429 usage_limit_exceeded・種類不明の 429・401・403・413・key-not-registered・unknown-destination）は 1 回だけ送られる", async () => {
    const nonRetryable: Array<[string, () => SecureTransportResponse]> = [
      ["429 usage_limit_exceeded", () => errorResponse(429, usageLimitBody("daily"))],
      ["429 種類不明", () => errorResponse(429, "not json")],
      ["401", () => errorResponse(401, "{}")],
      ["403", () => errorResponse(403, "{}")],
      ["413", () => errorResponse(413, "{}")],
      [
        "key-not-registered",
        () => {
          throw new SecureTransportError("key-not-registered");
        },
      ],
      [
        "unknown-destination",
        () => {
          throw new SecureTransportError("unknown-destination");
        },
      ],
    ];
    for (const [label, respond] of nonRetryable) {
      const { attempts } = await attemptsFor(respond);
      expect(attempts, label).toBe(1);
    }
  });
});
