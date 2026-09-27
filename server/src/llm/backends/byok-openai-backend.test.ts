import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeClient, streamBossMessage, requestVerdict } from "../claude-client.js";
import {
  getLlmBackendImplementation,
  resetLlmBackendRegistryForTest,
  type ResolvedLlmRequest,
} from "../llm-backend-registry.js";
import {
  SecureTransportError,
  type SecureTransportPort,
  type SecureTransportResponse,
  type SecureTransportSendRequest,
} from "../secure-transport-port.js";
import { ByokModelNotAllowedError } from "../model-catalog.js";
import {
  BYOK_OPENAI_BACKEND,
  OPENAI_RESPONSES_DESTINATION,
  OpenAiResponsesHttpError,
  OpenAiResponsesStreamError,
  classifyByokOpenAiError,
  registerByokOpenAiBackend,
} from "./byok-openai-backend.js";

/**
 * OpenAI Responses の形式の変換器と BYOK（OpenAI）バックエンドの受入基準
 * （S1。機能仕様 docs/features/llm-provider-abstraction.md）を固定する。
 * 転送のポートは常に模擬（実 API は呼ばない）。
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

/** テキストだけの最小限の正常系ストリーミング応答（delta を並べたあと completed）。 */
function textStreamEvents(textDeltas: string[], fullText = textDeltas.join("")): Record<string, unknown>[] {
  return [
    { type: "response.created" },
    ...textDeltas.map((delta) => ({ type: "response.output_text.delta", delta })),
    {
      type: "response.completed",
      response: {
        model: "gpt-6-sol",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: fullText }],
          },
        ],
      },
    },
  ];
}

function baseRequest(overrides: Partial<ResolvedLlmRequest> = {}): ResolvedLlmRequest {
  return {
    model: "gpt-6-sol",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1024,
    thinking: { type: "disabled" },
    ...overrides,
  };
}

function registerAndGetImpl(transport: SecureTransportPort) {
  registerByokOpenAiBackend(transport);
  const impl = getLlmBackendImplementation(BYOK_OPENAI_BACKEND)!;
  const client = impl.createClient({});
  return { impl, client };
}

beforeEach(() => {
  resetLlmBackendRegistryForTest();
});

afterEach(() => {
  resetLlmBackendRegistryForTest();
});

describe("BYOK（OpenAI）の登録と要求", () => {
  it("宣言する能力は runsOwnToolLoop=false / supportsToolChoice=true / limitsResponseLength=true", () => {
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(textStreamEvents(["ok"])))));
    registerByokOpenAiBackend(transport);
    const impl = getLlmBackendImplementation(BYOK_OPENAI_BACKEND)!;
    expect(impl.capabilities).toEqual({
      runsOwnToolLoop: false,
      supportsToolChoice: true,
      limitsResponseLength: true,
    });
  });

  it("送ると、ポートに渡る宛先の名前は openai-responses である（ストリーミング）", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(calls[0].request.destination).toBe(OPENAI_RESPONSES_DESTINATION);
    expect(OPENAI_RESPONSES_DESTINATION).toBe("openai-responses");
  });

  it("送ると、ポートに渡る宛先の名前は openai-responses である（非ストリーミング）", async () => {
    const nonStreamBody = JSON.stringify({ status: "completed", output: [] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(calls[0].request.destination).toBe(OPENAI_RESPONSES_DESTINATION);
  });

  it("要求本文の model は呼び出し元が指定したモデル ID である", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest({ model: "gpt-6-luna" }), {}, new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).model).toBe("gpt-6-luna");
  });

  it("要求本文に store の項目が無い（ストリーミング）", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("store" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("要求本文に store の項目が無い（非ストリーミング）", async () => {
    const nonStreamBody = JSON.stringify({ status: "completed", output: [] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect("store" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("要求本文に previous_response_id の項目が無い", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("previous_response_id" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("要求本文の tools の各要素は type: 'function' かつ strict: false である", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const tools = [
      { name: "do_it", description: "d", input_schema: { type: "object" as const, properties: {} } },
    ];
    await impl.streamRound(client, baseRequest({ tools }), {}, new AbortController().signal);
    const body = JSON.parse(calls[0].request.body);
    expect(body.tools).toEqual([
      { type: "function", name: "do_it", description: "d", parameters: { type: "object", properties: {} }, strict: false },
    ]);
  });

  it("要求本文の tools の名前の集合は、呼び出し元が渡したツールの名前の集合と一致する", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const tools = [
      { name: "a", description: "d1", input_schema: { type: "object" as const } },
      { name: "b", description: "d2", input_schema: { type: "object" as const } },
    ];
    await impl.streamRound(client, baseRequest({ tools }), {}, new AbortController().signal);
    const body = JSON.parse(calls[0].request.body);
    expect(new Set(body.tools.map((t: { name: string }) => t.name))).toEqual(new Set(["a", "b"]));
  });

  it("要求本文の tools の各要素の parameters は、呼び出し元が渡した input_schema と一致する", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const schema = { type: "object" as const, properties: { x: { type: "string" } }, required: ["x"] };
    const tools = [{ name: "a", description: "d", input_schema: schema }];
    await impl.streamRound(client, baseRequest({ tools }), {}, new AbortController().signal);
    const body = JSON.parse(calls[0].request.body);
    expect(body.tools[0].parameters).toEqual(schema);
  });

  it("要求本文の instructions は、呼び出し元が渡した system と一致する", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest({ system: "be terse" }), {}, new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).instructions).toBe("be terse");
  });

  it("呼び出し元が system を指定しないと、要求本文に instructions の項目が無い", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect("instructions" in JSON.parse(calls[0].request.body)).toBe(false);
  });

  it("呼び出し元が渡した user・assistant の文字列の履歴は、要求本文の input に同じ順・同じ役割・同じ本文で並ぶ", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(
      client,
      baseRequest({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "yo" },
          { role: "user", content: "again" },
        ],
      }),
      {},
      new AbortController().signal,
    );
    const body = JSON.parse(calls[0].request.body);
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "user", content: "again" },
    ]);
  });

  it("呼び出し元が toolChoice で submit_evening_summary を強制すると、要求本文の tool_choice は type: 'function' で名前が submit_evening_summary である", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(
      client,
      baseRequest({ toolChoice: { type: "tool", name: "submit_evening_summary" } }),
      {},
      new AbortController().signal,
    );
    const body = JSON.parse(calls[0].request.body);
    expect(body.tool_choice).toEqual({ type: "function", name: "submit_evening_summary" });
  });

  it.each([
    ["auto", "auto"],
    ["any", "required"],
    ["none", "none"],
  ] as const)("toolChoice %s は tool_choice %s になる", async (anthropicType, expected) => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(
      client,
      baseRequest({ toolChoice: { type: anthropicType } }),
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(calls[0].request.body).tool_choice).toBe(expected);
  });

  it("要求本文の max_output_tokens は、呼び出し元の maxTokens と一致する", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(client, baseRequest({ maxTokens: 4096 }), {}, new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).max_output_tokens).toBe(4096);
  });

  it("thinking: { type: 'disabled' } を渡すと、reasoning.effort はそのモデルの「推論なし」対応の値（none）である", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await impl.streamRound(
      client,
      baseRequest({ thinking: { type: "disabled" } }),
      {},
      new AbortController().signal,
    );
    expect(JSON.parse(calls[0].request.body).reasoning).toEqual({ effort: "none" });
  });

  it("thinking: { type: 'adaptive' } と effort: 'low' を渡すと、reasoning.effort はそのモデルの「チャット」対応の値（low）である", async () => {
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
    expect(JSON.parse(calls[0].request.body).reasoning).toEqual({ effort: "low" });
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
    const nonStreamBody = JSON.stringify({ status: "completed", output: [] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(JSON.parse(calls[0].request.body).stream).toBe(false);
  });
});

describe("モデルの一覧に無いモデルの送信前の関門", () => {
  it("一覧に無いモデル（gpt-6-astra）を streamRound で送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.streamRound(client, baseRequest({ model: "gpt-6-astra" }), {}, new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("一覧に無いモデル（gpt-6-astra）を createRound で送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const nonStreamBody = JSON.stringify({ status: "completed", output: [] });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(nonStreamBody)));
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.createRound(client, baseRequest({ model: "gpt-6-astra" }), new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("他方のプロバイダの一覧にあるモデル（claude-sonnet-5）を送ろうとすると失敗し、転送のポートは一度も呼ばれない", async () => {
    const { transport, calls } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["ok"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    await expect(
      impl.streamRound(client, baseRequest({ model: "claude-sonnet-5" }), {}, new AbortController().signal),
    ).rejects.toThrow(ByokModelNotAllowedError);
    expect(calls).toHaveLength(0);
  });

  it("モデルの一覧に無いモデルによる拒否は、classifyByokOpenAiError で再試行不可である", () => {
    const decision = classifyByokOpenAiError(new ByokModelNotAllowedError("openai", "gpt-6-astra"));
    expect(decision.retryable).toBe(false);
  });
});

describe("OpenAI の応答の解釈", () => {
  it("response.output_text.delta を2回返すと、onTextDelta は同じ順で2回、それぞれの差分の文字列で呼ばれる", async () => {
    const { transport } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents(["Hel", "lo"])))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls).toEqual([["Hel"], ["lo"]]);
  });

  it("断片の区切りが SSE のイベントの途中にあっても、onTextDelta が受け取る文字列の連結は応答の差分の連結と一致する", async () => {
    const fullText = buildSseText(textStreamEvents(["Hello", " world"]));
    const bytes = new TextEncoder().encode(fullText);
    const mid = Math.floor(bytes.length / 3);
    const chunks = [bytes.slice(0, mid), bytes.slice(mid)];
    const { transport } = singleResponseTransport(okResponse(asyncBody(chunks)));
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls.map((c) => c[0]).join("")).toBe("Hello world");
  });

  // PR #633 の Codex の指摘（P2）: SSE の行末は CRLF・CR・LF のいずれでもよい。
  it.each([
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("行末が %s の SSE でも、複数のイベントの境界を解釈して onTextDelta が順に呼ばれ本文が組み上がる", async (_label, eol) => {
    const sseText = buildSseText(textStreamEvents(["Hel", "lo"])).replace(/\n/g, eol);
    const { transport } = singleResponseTransport(okResponse(textBody(sseText)));
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    const message = await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls).toEqual([["Hel"], ["lo"]]);
    expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("CRLF の \\r と \\n が断片の境目で分かれても、複数行の data を1つのイベントとして解釈する", async () => {
    // 1つのイベントの JSON を2つの data: 行に分ける（SSE では "\n" で連結される）。
    const [deltaEvent, completedEvent] = [
      { type: "response.output_text.delta", delta: "Hi" },
      textStreamEvents(["Hi"])[2],
    ];
    const deltaJson = JSON.stringify(deltaEvent);
    const splitAt = deltaJson.indexOf(",") + 1;
    const firstPart = `event: response.output_text.delta\r\ndata: ${deltaJson.slice(0, splitAt)}\r`;
    const secondPart = `\ndata: ${deltaJson.slice(splitAt)}\r\n\r\n${sseEventText(completedEvent).replace(/\n/g, "\r\n")}`;
    const encoder = new TextEncoder();
    const { transport } = singleResponseTransport(
      okResponse(asyncBody([encoder.encode(firstPart), encoder.encode(secondPart)])),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    const message = await impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal);
    expect(onTextDelta.mock.calls).toEqual([["Hi"]]);
    expect(message.content).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("完了時の出力に function_call の項目があると、content に同じ call_id を id に持ち、同じ name と、arguments を JSON として解釈した値を input に持つ tool_use ブロックが入る", async () => {
    const events = [
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [{ type: "function_call", call_id: "call_1", name: "do_it", arguments: '{"a":1}' }],
        },
      },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "tool_use", id: "call_1", name: "do_it", input: { a: 1 } }]);
  });

  it("完了時の出力に message の output_text があると、content にその文字列の text ブロックが入る", async () => {
    const { transport } = singleResponseTransport(
      okResponse(textBody(buildSseText(textStreamEvents([], "よくやった")))),
    );
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "text", text: "よくやった" }]);
  });

  it("非ストリーミングの応答（JSON）でも、function_call は tool_use ブロックに、output_text は text ブロックになる", async () => {
    const responseBody = JSON.stringify({
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
        { type: "function_call", call_id: "call_9", name: "do_it", arguments: "{}" },
      ],
    });
    const { transport } = singleResponseTransport(okResponse(textBody(responseBody)));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(message.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_9", name: "do_it", input: {} },
    ]);
  });

  it("出力の項目配列全体が rawContent に入る（reasoning 項目を含む）", async () => {
    const outputItems = [
      { type: "reasoning", id: "r1", summary: [] },
      { type: "function_call", call_id: "call_1", name: "do_it", arguments: "{}" },
    ];
    const events = [{ type: "response.completed", response: { status: "completed", output: outputItems } }];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.rawContent).toEqual(outputItems);
  });

  // self-review（code-reviewer/design-reviewer 双方が独立に指摘・CONFIRMED/
  // PLAUSIBLE）: max_output_tokens を使い切った打ち切り（`status:
  // "incomplete"`）はストリーミングでは `response.completed` ではなく別の
  // 終端イベント（`response.incomplete`）で終わりうる。`response.completed`
  // だけを正常終了とみなすと、この終端が「途絶」（incomplete-stream・再試行
  // 可）に誤分類され、同一の打ち切られた要求が課金されたまま再送される
  // （機能仕様「応答の対応」: `status: "incomplete"` はメタ情報だけをログに
  // 出す——正常な終端として扱う。非ストリーミングの `interpretResponse` は
  // 既にこれを例外にしていない）。
  it("response.incomplete イベントで終わっても、途絶エラーにならず応答として解釈される（status: incomplete）", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
        },
      },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    expect(message.content).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("ツールのループ（1ターンの中の送り返し）", () => {
  it("2ラウンド目の input には1ラウンド目の出力の項目（reasoning を含む）が同じ値・同じ順で含まれ、その後ろに function_call_output が続く", async () => {
    const round1Output = [
      { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "let me think" }] },
      { type: "function_call", id: "fc1", call_id: "call-1", name: "do_it", arguments: "{}" },
    ];
    const round1Events = [
      { type: "response.completed", response: { status: "completed", output: round1Output } },
    ];
    const round2Events = textStreamEvents(["done"]);

    let callIndex = 0;
    const { transport, calls } = makeTransport(() => {
      const body = textBody(buildSseText(callIndex === 0 ? round1Events : round2Events));
      callIndex++;
      return okResponse(body);
    });
    registerByokOpenAiBackend(transport);
    const client = createClaudeClient({}, "byok-openai");

    const executeTool = vi.fn().mockResolvedValue({ content: "tool result text", isError: false });
    await streamBossMessage(client, { model: "gpt-6-sol", messages: [{ role: "user", content: "go" }] }, { executeTool });

    expect(calls).toHaveLength(2);
    const round2Body = JSON.parse(calls[1].request.body);
    const input = round2Body.input as unknown[];
    // 先頭は元のユーザーメッセージ、続いて1ラウンド目の出力の項目、末尾は function_call_output。
    expect(input[0]).toEqual({ role: "user", content: "go" });
    expect(input.slice(1, 3)).toEqual(round1Output);
    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "tool result text",
    });
    // self-review（design-reviewer, CONFIRMED）: 受入基準は「ツールのループの
    // 2ラウンド目を含む」と明記しており、1ラウンド目の本文だけでは
    // カバーしない。
    expect("previous_response_id" in round2Body).toBe(false);
    expect("store" in round2Body).toBe(false);
  });

  it("ツールの実行が失敗（isError: true）すると、function_call_output の output はエラーであることを示す文字列になり、成功時と区別できる", async () => {
    const round1Output = [{ type: "function_call", id: "fc1", call_id: "call-err", name: "do_it", arguments: "{}" }];
    const round1Events = [
      { type: "response.completed", response: { status: "completed", output: round1Output } },
    ];
    const round2Events = textStreamEvents(["done"]);

    let callIndex = 0;
    const { transport, calls } = makeTransport(() => {
      const body = textBody(buildSseText(callIndex === 0 ? round1Events : round2Events));
      callIndex++;
      return okResponse(body);
    });
    registerByokOpenAiBackend(transport);
    const client = createClaudeClient({}, "byok-openai");

    const executeTool = vi.fn().mockResolvedValue({ content: "boom", isError: true });
    await streamBossMessage(client, { model: "gpt-6-sol", messages: [{ role: "user", content: "go" }] }, { executeTool });

    const round2Body = JSON.parse(calls[1].request.body);
    const functionCallOutput = (round2Body.input as { type: string; output: string }[]).find(
      (item) => item.type === "function_call_output",
    )!;
    expect(functionCallOutput.output).not.toBe("boom");
    expect(functionCallOutput.output).toContain("boom");

    // 成功時（isError: false）と比較して、出力の文字列が異なることを確かめる。
    callIndex = 0;
    const { transport: okTransport, calls: okCalls } = makeTransport(() => {
      const body = textBody(buildSseText(callIndex === 0 ? round1Events : round2Events));
      callIndex++;
      return okResponse(body);
    });
    resetLlmBackendRegistryForTest();
    registerByokOpenAiBackend(okTransport);
    const okClient = createClaudeClient({}, "byok-openai");
    const okExecuteTool = vi.fn().mockResolvedValue({ content: "boom", isError: false });
    await streamBossMessage(okClient, { model: "gpt-6-sol", messages: [{ role: "user", content: "go" }] }, { executeTool: okExecuteTool });
    const okRound2Body = JSON.parse(okCalls[1].request.body);
    const okFunctionCallOutput = (okRound2Body.input as { type: string; output: string }[]).find(
      (item) => item.type === "function_call_output",
    )!;
    expect(okFunctionCallOutput.output).not.toBe(functionCallOutput.output);
  });
});

describe("夕会の要約抽出と同じ要求（toolChoice で submit_evening_summary を強制。実コード経由は reports/extract-evening-summary.openai.test.ts）", () => {
  it("夕会の要約抽出を BYOK（OpenAI）のバックエンドで呼ぶと、要求本文の tool_choice は submit_evening_summary の強制である", async () => {
    const responseBody = JSON.stringify({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "submit_evening_summary",
          arguments: JSON.stringify({
            report_summary: "タスクAを完了した",
            boss_comment: "よくやった",
            key_decisions: "なし",
            carry_over: "なし",
          }),
        },
      ],
    });
    const { transport, calls } = singleResponseTransport(okResponse(textBody(responseBody)));
    registerByokOpenAiBackend(transport);
    const client = createClaudeClient({}, "byok-openai");

    await requestVerdict(
      client,
      {
        model: "gpt-6-sol",
        messages: [{ role: "user", content: "summarize" }],
        tools: [{ name: "submit_evening_summary", description: "d", input_schema: { type: "object" } }],
        toolChoice: { type: "tool", name: "submit_evening_summary" },
      },
      "submit_evening_summary",
      (input) => ({ valid: true, data: input }),
    );

    expect(calls[0].request.destination).toBe(OPENAI_RESPONSES_DESTINATION);
    const body = JSON.parse(calls[0].request.body);
    expect(body.tool_choice).toEqual({ type: "function", name: "submit_evening_summary" });
  });
});

describe("エラーの分類", () => {
  it("応答のステータスが 429 のとき、分類は再試行可である", () => {
    const decision = classifyByokOpenAiError(new OpenAiResponsesHttpError(429));
    expect(decision.retryable).toBe(true);
  });

  it("応答のステータスが 429 で retry-after が秒数のとき、分類の待ち時間はその秒数をミリ秒にした値である", () => {
    const decision = classifyByokOpenAiError(new OpenAiResponsesHttpError(429, "3"));
    expect(decision.retryAfterMs).toBe(3000);
  });

  it("応答のステータスが 429 でエラー本文の error.code が insufficient_quota のとき、分類は再試行不可である", () => {
    const decision = classifyByokOpenAiError(new OpenAiResponsesHttpError(429, undefined, "insufficient_quota"));
    expect(decision.retryable).toBe(false);
  });

  // self-review（code-reviewer, CONFIRMED）: 上のテストは
  // OpenAiResponsesHttpError を直接組み立てるだけで、応答本文から
  // error.code を読む tryExtractErrorCode（streamRound/createRound が
  // 実際に通る経路）を経由しない。ここでは模擬の転送のポートに 429 と
  // JSON 本文を返させ、impl.streamRound が投げた失敗を分類することで、
  // 実際の応答本文の読み取りを経由した経路を固定する。
  it("応答本文が { error: { code: 'insufficient_quota' } } の 429 を impl.streamRound で受けると、投げた失敗の分類は再試行不可である", async () => {
    const { transport } = singleResponseTransport({
      status: 429,
      headers: {},
      body: textBody(JSON.stringify({ error: { code: "insufficient_quota", message: "quota exceeded" } })),
    });
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesHttpError);
    expect((caught as OpenAiResponsesHttpError).errorCode).toBe("insufficient_quota");
    expect(classifyByokOpenAiError(caught).retryable).toBe(false);
  });

  // self-review（code-reviewer, 2周目, CONFIRMED）: 500 では insufficient_quota
  // の特別扱い（`error.status === 429 && errorCode === "insufficient_quota"`）
  // にそもそも到達しないため、`caught` が何であっても・`errorCode` が何で
  // あっても通ってしまう恒真に近いテストだった。429 に insufficient_quota
  // **以外**の error.code を組み合わせ、instanceOf・errorCode・retryable の
  // 3点を確かめることで、429 の特別扱いが insufficient_quota 以外へ広がる
  // 退行（本来防ぎたい契約）を検出できる形にする。
  it("応答本文が { error: { code: 'rate_limit_exceeded' } } の 429 を impl.streamRound で受けると、投げた失敗は errorCode を保持し、分類は再試行可である（insufficient_quota 以外の error.code は特別扱いしない）", async () => {
    const { transport } = singleResponseTransport({
      status: 429,
      headers: {},
      body: textBody(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "boom" } })),
    });
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesHttpError);
    expect((caught as OpenAiResponsesHttpError).errorCode).toBe("rate_limit_exceeded");
    expect(classifyByokOpenAiError(caught).retryable).toBe(true);
  });

  it.each([401, 400])("応答のステータスが %i のとき、分類は再試行不可である", (status) => {
    const decision = classifyByokOpenAiError(new OpenAiResponsesHttpError(status));
    expect(decision.retryable).toBe(false);
  });

  it.each([500, 503])("応答のステータスが %i のとき、分類は再試行可である", (status) => {
    const decision = classifyByokOpenAiError(new OpenAiResponsesHttpError(status));
    expect(decision.retryable).toBe(true);
  });

  it("ポートが「接続失敗」で失敗すると、分類は再試行可である", () => {
    const decision = classifyByokOpenAiError(new SecureTransportError("connection"));
    expect(decision.retryable).toBe(true);
  });

  it("ポートが「キー未登録」で失敗すると、分類は再試行不可である", () => {
    const decision = classifyByokOpenAiError(new SecureTransportError("key-not-registered"));
    expect(decision.retryable).toBe(false);
  });

  it("応答のステータスが2xxでないとき、そのラウンドは失敗し、onTextDelta は呼ばれない", async () => {
    const { transport } = singleResponseTransport({
      status: 500,
      headers: {},
      body: textBody(buildSseText(textStreamEvents(["should not reach"]))),
    });
    const { impl, client } = registerAndGetImpl(transport);
    const onTextDelta = vi.fn();
    await expect(
      impl.streamRound(client, baseRequest(), { onTextDelta }, new AbortController().signal),
    ).rejects.toThrow(OpenAiResponsesHttpError);
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it("SSE の error イベントがあると、そのラウンドは失敗し、分類は再試行可である", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "error", code: "server_error", message: "boom" },
    ];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesStreamError);
    expect(classifyByokOpenAiError(caught).retryable).toBe(true);
  });

  it("response.failed イベントがあると、そのラウンドは失敗し、分類は再試行可である", async () => {
    const events = [{ type: "response.failed", response: { status: "failed" } }];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesStreamError);
    // self-review（design-reviewer, CONFIRMED）: タイトルの後半（「分類は
    // 再試行可である」）を確かめていなかった。
    expect(classifyByokOpenAiError(caught).retryable).toBe(true);
  });

  it("応答の本文が response.completed の前に終わると、そのラウンドは失敗し、分類は再試行可である", async () => {
    const events = [{ type: "response.output_text.delta", delta: "partial" }];
    const { transport } = singleResponseTransport(okResponse(textBody(buildSseText(events))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.streamRound(client, baseRequest(), {}, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesStreamError);
    expect(classifyByokOpenAiError(caught).retryable).toBe(true);
  });

  it("投げる失敗の値の message に、要求本文の文字列と応答本文の文字列が含まれない", async () => {
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
    expect(caught).toBeInstanceOf(OpenAiResponsesHttpError);
    expect((caught as Error).message).not.toContain(secretRequestMarker);
    expect((caught as Error).message).not.toContain(secretResponseMarker);
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
    expect(caught).toBeInstanceOf(OpenAiResponsesStreamError);
    expect((caught as Error).message).not.toContain(secretResponseMarker);
    expect((caught as Error).message).not.toContain("not-json");
  });

  // PR #633 の Codex の指摘（P2・2 巡目）: 非ストリーミングで 2xx の JSON が
  // 失敗（`status: "failed"`・`error` あり）を返したら、成功扱いで空の内容に
  // 正規化せず、ストリーミングの `response.failed` と同じ失敗・分類に乗せる。
  it.each([
    ["status: failed と error", { status: "failed", error: { code: "server_error", message: "LEAK_MARKER_failed" }, output: [] }],
    ["error だけ（status 無し）", { error: { code: "server_error", message: "LEAK_MARKER_failed" }, output: [] }],
    ["status: failed だけ（error は null）", { status: "failed", error: null, output: [] }],
  ])("非ストリーミングの 2xx の応答が失敗（%s）を示すと、そのラウンドは失敗し、分類は再試行可で、message に応答の本文が含まれない", async (_label, body) => {
    const { transport } = singleResponseTransport(okResponse(textBody(JSON.stringify(body))));
    const { impl, client } = registerAndGetImpl(transport);
    let caught: unknown;
    try {
      await impl.createRound(client, baseRequest(), new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiResponsesStreamError);
    expect(classifyByokOpenAiError(caught).retryable).toBe(true);
    expect((caught as Error).message).not.toContain("LEAK_MARKER_failed");
  });

  it("非ストリーミングの 2xx の応答が status: incomplete（error は null）なら、ストリーミングの response.incomplete と同じく失敗にせず応答として解釈される", async () => {
    const body = {
      status: "incomplete",
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }],
    };
    const { transport } = singleResponseTransport(okResponse(textBody(JSON.stringify(body))));
    const { impl, client } = registerAndGetImpl(transport);
    const message = await impl.createRound(client, baseRequest(), new AbortController().signal);
    expect(message.content).toEqual([{ type: "text", text: "partial" }]);
  });
});

describe("失敗時に別の宛先・別のモデルへ自動で切り替えない（claude-client.ts のファサードの再試行経由）", () => {
  // streamBossMessage は失敗（500・再試行可）のたびに runWithTimeoutAndRetry
  // の指数バックオフで最大2回まで再試行する。フェイクタイマーで待ち時間を
  // 進め、実時間を使わずに複数回の送信を観測する。
  it("送信が失敗しても、転送のポートへ openai-responses 以外の宛先の名前の要求は送られない", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = makeTransport(() => ({ status: 500, headers: {}, body: textBody("") }));
      registerByokOpenAiBackend(transport);
      const client = createClaudeClient({}, "byok-openai");
      const promise = streamBossMessage(client, { model: "gpt-6-sol", messages: [{ role: "user", content: "hi" }] }, {}, {});
      const expectation = expect(promise).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);
      await expectation;
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((c) => c.request.destination === OPENAI_RESPONSES_DESTINATION)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("送信が失敗しても、要求本文の model は変わらない", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = makeTransport(() => ({ status: 500, headers: {}, body: textBody("") }));
      registerByokOpenAiBackend(transport);
      const client = createClaudeClient({}, "byok-openai");
      const promise = streamBossMessage(
        client,
        { model: "gpt-6-luna", messages: [{ role: "user", content: "hi" }] },
        {},
        {},
      );
      const expectation = expect(promise).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 1);
      await expectation;
      const models = new Set(calls.map((c) => JSON.parse(c.request.body).model));
      expect(models).toEqual(new Set(["gpt-6-luna"]));
    } finally {
      vi.useRealTimers();
    }
  });
});
