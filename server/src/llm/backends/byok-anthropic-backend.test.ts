import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeClient, streamBossMessage, requestVerdict } from "../claude-client.js";
import {
  getLlmBackendImplementation,
  resetLlmBackendRegistryForTest,
  type ResolvedLlmRequest,
} from "../llm-backend-registry.js";
import {
  ANTHROPIC_MESSAGES_DESTINATION,
  SecureTransportError,
  type SecureTransportPort,
  type SecureTransportResponse,
  type SecureTransportSendRequest,
} from "../secure-transport-port.js";
import {
  AnthropicMessagesHttpError,
  AnthropicMessagesStreamError,
  BYOK_ANTHROPIC_BACKEND,
  classifyByokAnthropicError,
  registerByokAnthropicBackend,
} from "./byok-anthropic-backend.js";
import { ByokModelNotAllowedError } from "../model-catalog.js";

/**
 * SDK を使わない Anthropic Messages クライアントと転送のポートの上に作る
 * BYOK（Anthropic）バックエンドの受入基準（S2。機能仕様
 * docs/features/secure-transport-byok.md）を固定する。転送のポートは常に
 * 模擬（実 API は呼ばない）。
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

function singleResponseTransport(response: SecureTransportResponse) {
  return makeTransport(() => response);
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

function textBody(text: string): AsyncIterable<Uint8Array> {
  return asyncBody([new TextEncoder().encode(text)]);
}

function sseEventText(data: Record<string, unknown>): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildSseText(events: Record<string, unknown>[]): string {
  return events.map(sseEventText).join("");
}

function okResponse(body: AsyncIterable<Uint8Array>, headers: SecureTransportResponse["headers"] = {}): SecureTransportResponse {
  return { status: 200, headers, body };
}

/** テキストだけの最小限の正常系ストリーミング応答（`text` を2回に分けて
 * text_delta で返す）。 */
function textStreamEvents(textDeltas: string[]): Record<string, unknown>[] {
  return [
    { type: "message_start", message: { model: "claude-sonnet-5", usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...textDeltas.map((text) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function baseRequest(overrides: Partial<ResolvedLlmRequest> = {}): ResolvedLlmRequest {
  return {
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1024,
    thinking: { type: "disabled" },
    ...overrides,
  };
}

function registerAndGetImpl(transport: SecureTransportPort) {
  registerByokAnthropicBackend(transport);
  const impl = getLlmBackendImplementation(BYOK_ANTHROPIC_BACKEND)!;
  const client = impl.createClient({});
  return { impl, client };
}

beforeEach(() => {
  resetLlmBackendRegistryForTest();
});

afterEach(() => {
  resetLlmBackendRegistryForTest();
});

describe("BYOK（Anthropic）の登録と要求", () => {
  it("registerByokAnthropicBackend の後、createClaudeClient(env, 'byok-anthropic') は env に ANTHROPIC_API_KEY が無くても失敗しない", () => {
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(textStreamEvents(["ok"])))));
    registerByokAnthropicBackend(transport);
    expect(() => createClaudeClient({}, "byok-anthropic")).not.toThrow();
  });

  it("宣言する能力は runsOwnToolLoop=false / supportsToolChoice=true / limitsResponseLength=true", () => {
    const { transport } = singleResponseTransport(okResponse(textBody("")));
    registerByokAnthropicBackend(transport);
    const impl = getLlmBackendImplementation(BYOK_ANTHROPIC_BACKEND)!;
    expect(impl.capabilities).toEqual({
      runsOwnToolLoop: false,
      supportsToolChoice: true,
      limitsResponseLength: true,
    });
  });

  it("送ると、ポートに渡る宛先の名前は anthropic-messages である（ストリーミング）", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(calls[0].request.destination).toBe(ANTHROPIC_MESSAGES_DESTINATION);
  });

  it("送ると、ポートに渡る宛先の名前は anthropic-messages である（非ストリーミング）", async () => {
    const nonStreamBody = JSON.stringify({ content: [{ type: "text", text: "ok" }] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(calls[0].request.destination).toBe(ANTHROPIC_MESSAGES_DESTINATION);
  });

  it("ポートに渡る要求の headers に x-api-key・authorization・anthropic-version のいずれも無い（大文字小文字を区別しない）", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    const headerKeys = Object.keys(calls[0].request.headers ?? {}).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("x-api-key");
    expect(headerKeys).not.toContain("authorization");
    expect(headerKeys).not.toContain("anthropic-version");
  });

  it("env の ANTHROPIC_API_KEY に値を入れてクライアントを作っても、ポートに渡る要求の headers の値と本文に、その値の文字列が現れない", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    registerByokAnthropicBackend(transport);
    const client = createClaudeClient({ ANTHROPIC_API_KEY: "sk-ant-super-secret-value" }, "byok-anthropic");
    const impl = getLlmBackendImplementation(BYOK_ANTHROPIC_BACKEND)!;
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    const serializedHeaders = JSON.stringify(calls[0].request.headers ?? {});
    expect(serializedHeaders).not.toContain("sk-ant-super-secret-value");
    expect(calls[0].request.body).not.toContain("sk-ant-super-secret-value");
  });

  it("ストリーミングの要求本文の stream は true", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).stream).toBe(true);
  });

  it("非ストリーミングの要求本文の stream は false", async () => {
    const nonStreamBody = JSON.stringify({ content: [{ type: "text", text: "ok" }] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).stream).toBe(false);
  });

  it("要求本文の model・max_tokens・system・messages・tools を呼び出し元の値どおりに送る", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const tools = [{ name: "do_it", description: "d", input_schema: { type: "object" as const } }];
    await impl.streamRound(
      client,
      baseRequest({
        model: "claude-haiku-4-5",
        maxTokens: 4096,
        system: "be terse",
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
        tools,
      }),
      {},
      new AbortController().signal,
    );
    const body = JSON.parse(calls[0].request.body);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toBe("be terse");
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(body.tools).toEqual(tools);
  });

  it("呼び出し元が system を指定しないと、要求本文に system の項目が無い", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("system" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("呼び出し元が tools を渡さないと、要求本文に tools の項目が無い", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("tools" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("呼び出し元が thinking を指定しないと、要求本文の thinking は { type: 'disabled' } である", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).thinking).toEqual({ type: "disabled" });
  });

  it("呼び出し元が thinking: { type: 'adaptive' } と outputConfig: { effort: 'low' } を渡すと、要求本文の thinking/output_config へ反映される", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(
      client,
      baseRequest({ thinking: { type: "adaptive" }, outputConfig: { effort: "low" } }),
      {},
      new AbortController().signal,
    );
    const body = JSON.parse(calls[0].request.body);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("呼び出し元が outputConfig を渡さないと、要求本文に output_config の項目が無い", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("output_config" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  // self-review（design-reviewer, CONFIRMED）: このテストはあくまで
  // requestVerdict → createClaudeClient(env, "byok-anthropic") 直呼びで
  // 「toolChoice が tool_choice としてそのまま転送される」ことだけを確かめる
  // ——`reports/extract-evening-summary.ts` を実際には呼んでいない。S2 では
  // `resolveLlmBackend(env)`（`LlmBackend` 型。`"api" | "claude-code"` のみ）
  // が `LLM_BACKEND` から選ぶバックエンドを解決するため、夕会の要約抽出が
  // `env` 経由で "byok-anthropic" を選ぶ経路は無い（BYOK の選択は S3 が
  // Tauri の設定から直接組み立てる想定）。夕会の要約抽出→BYOK の結合その
  // ものは `reports/extract-evening-summary.byok.test.ts` が、BYOK の実装を
  // 名前 `api` の下にも登録して固定する。
  it("requestVerdict が渡した toolChoice（submit_evening_summary を強制する形）は、要求本文の tool_choice にそのまま転記される", async () => {
    const responseText = JSON.stringify({
      content: [{ type: "tool_use", id: "t1", name: "submit_evening_summary", input: { a: 1 } }],
    });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(responseText)));
    registerByokAnthropicBackend(transport);
    const client = createClaudeClient({}, "byok-anthropic");

    await requestVerdict(
      client,
      {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "summarize" }],
        tools: [{ name: "submit_evening_summary", description: "d", input_schema: { type: "object" } }],
        toolChoice: { type: "tool", name: "submit_evening_summary" },
      },
      "submit_evening_summary",
      (input) => ({ valid: true, data: input }),
    );

    const body = JSON.parse(calls[0].request.body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_evening_summary" });
  });
});

describe("ストリーミングの応答の解釈", () => {
  it("text_delta を2回返すと、onTextDelta は同じ順で2回、それぞれの差分の文字列で呼ばれる", async () => {
    const { transport } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["Hel", "lo"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls).toEqual([["Hel"], ["lo"]]);
  });

  it("断片の区切りが SSE のイベントの途中にあっても、onTextDelta が受け取る文字列の連結は text_delta の連結と一致する", async () => {
    const fullText = buildSseText(textStreamEvents(["Hello", " world"]));
    const bytes = new TextEncoder().encode(fullText);
    // イベントの内部（"data: {...}" の途中）で分割する。
    const mid = Math.floor(bytes.length / 3);
    const chunks = [bytes.slice(0, mid), bytes.slice(mid)];
    const { transport } = singleResponseTransport(okResponse(asyncBody(chunks)));
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls.map((c) => c[0]).join("")).toBe("Hello world");
  });

  it("断片の区切りが UTF-8 の多バイト文字のバイト列の途中にあっても、onTextDelta が受け取る文字列の連結は text_delta の連結と一致する（U+FFFD が現れない）", async () => {
    const fullText = buildSseText(textStreamEvents(["上司"]));
    const bytes = new TextEncoder().encode(fullText);
    // "上司" のバイト列（3バイト文字×2）の内部で分割する。
    const marker = new TextEncoder().encode('"上司"');
    const markerIndex = indexOfBytes(bytes, marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const splitAt = markerIndex + 2; // "上" の3バイトの内側
    const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)];
    const { transport } = singleResponseTransport(okResponse(asyncBody(chunks)));
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    const joined = onTextDelta.mock.calls.map((c) => c[0]).join("");
    expect(joined).toBe("上司");
    expect(joined).not.toContain("�");
  });

  it("tool_use のブロックで input_json_delta を2回以上に分けて返すと、content の tool_use は id/name と、連結してJSONとして解釈した input を持つ", async () => {
    const events = [
      { type: "message_start", message: { model: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "do_it" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "tool_use", id: "t1", name: "do_it", input: { a: 1 } }]);
  });

  it("tool_use のブロックに input_json_delta が1回も無いと、input は {} である", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "do_it" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "tool_use", id: "t1", name: "do_it", input: {} }]);
  });

  it("text のブロックは、content に同じ文字列の text ブロックとして入る", async () => {
    const { transport } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["よくやった"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "text", text: "よくやった" }]);
  });

  it("thinking のブロック（thinking_delta と signature_delta）は content に入らず、rawContent には thinking/signature を連結した値が入る", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ok" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
    expect(message.rawContent).toEqual([
      { type: "thinking", thinking: "hmm ok", signature: "sig-abc" },
      { type: "text", text: "done" },
    ]);
  });

  it("redacted_thinking のブロックがあると、rawContent に同じ data を持つ redacted_thinking のブロックが入る", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque-data" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.rawContent).toEqual([{ type: "redacted_thinking", data: "opaque-data" }]);
  });

  // self-review（design-reviewer, CONFIRMED）: 元のテストは index 0→1 の
  // 到達順どおりに送っており、実装が「到達順」と「index 順」のどちらで
  // 並べても同じ結果になっていたため、契約（index の値そのもので並べる）を
  // 検知できていなかった。ここでは index 1 のブロックを**先に**、index 0
  // のブロックを**後に**送り、出力が到達順ではなく index の昇順になる
  // ことを確かめる。
  it("rawContent のブロックは、到達順ではなく応答のブロックの index の順に並ぶ", async () => {
    const eventsOutOfArrivalOrder = [
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "second" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "first" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(
      okResponse(textBody(buildSseText(eventsOutOfArrivalOrder))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.rawContent).toEqual([
      { type: "tool_use", id: "t0", name: "first", input: {} },
      { type: "text", text: "second" },
    ]);
  });

  it("ping のイベントが挟まっても、BossLlmMessage は ping が無い場合と同じである", async () => {
    const withPing = [
      textStreamEvents(["hi"])[0],
      { type: "ping" },
      ...textStreamEvents(["hi"]).slice(1),
    ];
    const withoutPing = textStreamEvents(["hi"]);
    const { transport: t1 } = singleResponseTransport(okResponse(textBody(buildSseText(withPing))));
    const { impl: impl1, client: client1 } = registerAndGetImpl(t1);
    const withPingMessage = await impl1.streamRound(client1, baseRequest(), {}, new AbortController().signal);

    resetLlmBackendRegistryForTest();
    const { transport: t2 } = singleResponseTransport(okResponse(textBody(buildSseText(withoutPing))));
    const { impl: impl2, client: client2 } = registerAndGetImpl(t2);
    const withoutPingMessage = await impl2.streamRound(client2, baseRequest(), {}, new AbortController().signal);

    expect(withPingMessage).toEqual(withoutPingMessage);
  });

  it("text・tool_use のブロックが1つも無い（thinking だけの）とき、console.warn に渡る値に thinking の文字列が含まれない", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "secret reasoning" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
      expect(warnSpy).toHaveBeenCalled();
      const serializedArgs = JSON.stringify(warnSpy.mock.calls);
      expect(serializedArgs).not.toContain("secret reasoning");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("非ストリーミングの応答の解釈", () => {
  it("content の text/tool_use が同じ値のブロックになる（複数の断片に分けて返す）", async () => {
    const fullJson = JSON.stringify({
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "do_it", input: { a: 1 } },
      ],
    });
    const bytes = new TextEncoder().encode(fullJson);
    const mid = Math.floor(bytes.length / 2);
    const { transport } = singleResponseTransport(
      okResponse(asyncBody([bytes.slice(0, mid), bytes.slice(mid)])),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(message.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "do_it", input: { a: 1 } },
    ]);
  });

  it("content 全体（thinking を含む）は、同じ順・同じ値で rawContent に入る", async () => {
    const rawContent = [
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "hello" },
    ];
    const fullJson = JSON.stringify({ content: rawContent });
    const { transport } = singleResponseTransport(okResponse(textBody(fullJson)));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(message.rawContent).toEqual(rawContent);
  });
});

describe("ツールのループ（ファサード経由の送り返し）", () => {
  it("thinking（署名つき）と tool_use を返すと、2回目の要求本文の messages に1回目の rawContent と同じ値・同じ順のブロックを持つ assistant のメッセージが含まれ、末尾は tool_use_id を持つ tool_result の user メッセージである", async () => {
    const round1Events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "do_it" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    const round2Events = textStreamEvents(["done"]);

    let callIndex = 0;
    const { transport, calls } = makeTransport(() => {
      const body = textBody(buildSseText(callIndex === 0 ? round1Events : round2Events));
      callIndex++;
      return okResponse(body);
    });
    registerByokAnthropicBackend(transport);
    const client = createClaudeClient({}, "byok-anthropic");

    const executeTool = vi.fn().mockResolvedValue({ content: "tool result text", isError: false });
    await streamBossMessage(client, { messages: [{ role: "user", content: "go" }] }, { executeTool });

    expect(calls).toHaveLength(2);
    const round2Body = JSON.parse(calls[1].request.body);
    const messages = round2Body.messages as unknown[];
    const assistantMessage = messages[messages.length - 2] as { role: string; content: unknown[] };
    expect(assistantMessage.role).toBe("assistant");
    expect(assistantMessage.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "sig-1" },
      { type: "tool_use", id: "tool-1", name: "do_it", input: {} },
    ]);
    const toolResultMessage = messages[messages.length - 1] as {
      role: string;
      content: { type: string; tool_use_id: string }[];
    };
    expect(toolResultMessage.role).toBe("user");
    expect(toolResultMessage.content[0].type).toBe("tool_result");
    expect(toolResultMessage.content[0].tool_use_id).toBe("tool-1");
  });
});

describe("エラーの分類", () => {
  it.each([429, 408, 500, 503, 529])("HTTP ステータス %i は再試行可である", (status) => {
    const decision = classifyByokAnthropicError(new AnthropicMessagesHttpError(status));
    expect(decision.retryable).toBe(true);
  });

  it.each([400, 401, 403, 404])("HTTP ステータス %i は再試行不可である", (status) => {
    const decision = classifyByokAnthropicError(new AnthropicMessagesHttpError(status));
    expect(decision.retryable).toBe(false);
  });

  it("429 で retry-after が '3' のとき、待ち時間は3000msである", () => {
    const decision = classifyByokAnthropicError(new AnthropicMessagesHttpError(429, "3"));
    expect(decision.retryAfterMs).toBe(3000);
  });

  it("基準の時刻を固定し、retry-after が HTTP 日付のとき、待ち時間はその差分である", () => {
    const now = new Date("2026-09-27T00:00:00Z");
    const decision = classifyByokAnthropicError(
      new AnthropicMessagesHttpError(429, "Sun, 27 Sep 2026 00:00:05 GMT"),
      now,
    );
    expect(decision.retryAfterMs).toBe(5000);
  });

  it("同じ基準の時刻で、retry-after が過去の HTTP 日付のとき、待ち時間は無い", () => {
    const now = new Date("2026-09-27T00:00:00Z");
    const decision = classifyByokAnthropicError(
      new AnthropicMessagesHttpError(429, "Sat, 26 Sep 2026 23:59:55 GMT"),
      now,
    );
    expect(decision.retryAfterMs).toBeUndefined();
  });

  it("retry-after が数値でも HTTP 日付でもない値のとき、待ち時間は無い", () => {
    const decision = classifyByokAnthropicError(new AnthropicMessagesHttpError(429, "soon"));
    expect(decision.retryAfterMs).toBeUndefined();
  });

  it("ポートが「接続失敗」で失敗すると、分類は再試行可である", () => {
    const decision = classifyByokAnthropicError(new SecureTransportError("connection"));
    expect(decision.retryable).toBe(true);
  });

  it.each([
    "unknown-destination",
    "key-not-registered",
    "key-store-failure",
    "invalid-header",
    "duplicate-request-id",
    "redirect-refused",
  ] as const)("ポートが「%s」で失敗すると、分類は再試行不可である", (kind) => {
    const decision = classifyByokAnthropicError(new SecureTransportError(kind, { status: 302 }));
    expect(decision.retryable).toBe(false);
  });

  it("応答のステータスが2xxでないとき、そのラウンドは失敗し、text_delta の形のイベントがあっても onTextDelta は呼ばれない", async () => {
    const { transport } = singleResponseTransport(
      { status: 500, headers: {}, body: textBody(buildSseText(textStreamEvents(["should not reach"]))) },
    );
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await expect(
      impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal),
    ).rejects.toThrow(AnthropicMessagesHttpError);
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("SSE の error イベントがあると、そのラウンドは失敗し、分類は再試行可である", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesStreamError);
    expect(classifyByokAnthropicError(caught).retryable).toBe(true);
  });

  it("応答の本文が message_stop の前に終わると、そのラウンドは失敗し、分類は再試行可である", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesStreamError);
    expect(classifyByokAnthropicError(caught).retryable).toBe(true);
  });

  it("投げる失敗の値の message に、要求本文の文字列と応答本文の文字列が含まれない（HTTP のエラーの応答本文を含む）", async () => {
    const secretRequestMarker = "REQUEST_MARKER_abc123";
    const secretResponseMarker = "RESPONSE_MARKER_xyz789";
    const { transport } = singleResponseTransport({
      status: 503,
      headers: {},
      body: textBody(JSON.stringify({ error: { message: secretResponseMarker } })),
    });
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(
        client,
        baseRequest({ system: secretRequestMarker }),
        {},
        new AbortController().signal,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesHttpError);
    expect((caught as Error).message).not.toContain(secretRequestMarker);
    expect((caught as Error).message).not.toContain(secretResponseMarker);
  });

  // self-review（code-reviewer/design-reviewer 双方が独立に指摘・
  // CONFIRMED）: V8 の SyntaxError#message は解釈できなかった入力の断片
  // （応答本文）をそのまま含む。SSE の data 行が壊れた JSON でも、素の
  // JSON.parse の失敗をそのまま伝播させない（固定文言の
  // AnthropicMessagesStreamError へ変換する）ことを確かめる。
  it("SSE の data 行が壊れた JSON でも、投げる失敗の値の message に応答本文の断片が含まれない", async () => {
    const secretResponseMarker = "LEAK_MARKER_qrstuv";
    const malformedSse = `event: content_block_delta\ndata: not-json ${secretResponseMarker}\n\n`;
    const { transport } = singleResponseTransport(okResponse(textBody(malformedSse)));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesStreamError);
    expect((caught as Error).message).not.toContain(secretResponseMarker);
    expect((caught as Error).message).not.toContain("not-json");
    expect(classifyByokAnthropicError(caught).retryable).toBe(true);
  });

  it("非ストリーミングの応答本文が壊れた JSON でも、投げる失敗の値の message に応答本文の断片が含まれない", async () => {
    const secretResponseMarker = "LEAK_MARKER_nonstream";
    const { transport } = singleResponseTransport(okResponse(textBody(`not-json ${secretResponseMarker}`)));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.createRound(client, baseRequest(), new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesStreamError);
    expect((caught as Error).message).not.toContain(secretResponseMarker);
    // self-review（code-reviewer, 2周目, CONFIRMED）: V8 の SyntaxError#message
    // は入力の先頭断片（例: `"not-json LE"...`）で切られるため、末尾寄りの
    // マーカーだけを確かめると、素の SyntaxError へ戻す変異が検出できない
    // （マーカーがそもそも先頭断片に入らない）。先頭断片そのものも確かめる。
    expect((caught as Error).message).not.toContain("not-json");
  });

  it("tool_use の partial_json が壊れた JSON でも、投げる失敗の値の message に応答本文の断片が含まれない", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "do_it" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "not-json LEAK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnthropicMessagesStreamError);
    expect((caught as Error).message).not.toContain("LEAK");
    expect((caught as Error).message).not.toContain("not-json");
  });
});

describe("モデルの一覧に無いモデルの送信前の関門（機能仕様 docs/features/llm-provider-abstraction.md クリティカル設計決定3）", () => {
  it("一覧に無いモデル（claude-opus-5-5）を streamRound で送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.streamRound(client, baseRequest({ model: "claude-opus-5-5" }), {}, new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("一覧に無いモデル（claude-opus-5-5）を createRound で送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const nonStreamBody = JSON.stringify({ content: [{ type: "text", text: "ok" }] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.createRound(client, baseRequest({ model: "claude-opus-5-5" }), new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("他方のプロバイダの一覧にあるモデル（gpt-6-sol）を送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.streamRound(client, baseRequest({ model: "gpt-6-sol" }), {}, new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("モデルの一覧に無いモデルによる拒否は、classifyByokAnthropicError で再試行不可である", () => {
    const decision = classifyByokAnthropicError(new ByokModelNotAllowedError("anthropic", "claude-opus-5-5"));
    expect(decision.retryable).toBe(false);
  });

  it("一覧にあるモデル（claude-sonnet-5）は関門を通過し、通常どおり送信される", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest({ model: "claude-sonnet-5" }), {}, new AbortController().signal);
    expect(calls).toHaveLength(1);
  });
});

describe("中止", () => {
  it("streamBossMessage の signal を、1つ目の断片を受け取った後に中止すると、ポートに渡った signal が中止され、streamBossMessage は失敗する", async () => {
    let capturedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const transport: SecureTransportPort = async (_request, signal) => {
      capturedSignal = signal;
      const firstChunk = new TextEncoder().encode(sseEventText(textStreamEvents(["hi"])[1] as Record<string, unknown>));
      return okResponse({
        async *[Symbol.asyncIterator]() {
          yield firstChunk;
          controller.abort();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new SecureTransportError("cancelled")), {
              once: true,
            });
          });
        },
      });
    };
    registerByokAnthropicBackend(transport);
    const client = createClaudeClient({}, "byok-anthropic");

    await expect(
      streamBossMessage(client, { messages: [{ role: "user", content: "hi" }] }, {}, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("送信の前に中止済みの signal を渡すと、ポートは呼ばれないか、呼ばれた時点で渡った signal が中止済みである", async () => {
    let capturedSignal: AbortSignal | undefined;
    let called = false;
    const transport: SecureTransportPort = async (_request, signal) => {
      called = true;
      capturedSignal = signal;
      return okResponse(textBody(buildSseText(textStreamEvents(["hi"]))));
    };
    registerByokAnthropicBackend(transport);
    const client = createClaudeClient({}, "byok-anthropic");

    const controller = new AbortController();
    controller.abort();

    await streamBossMessage(
      client,
      { messages: [{ role: "user", content: "hi" }] },
      {},
      { signal: controller.signal },
    ).catch(() => {});

    if (called) {
      expect(capturedSignal?.aborted).toBe(true);
    }
  });
});

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
