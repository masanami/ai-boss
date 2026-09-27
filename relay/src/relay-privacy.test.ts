import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_OPERATOR_KEY,
  TOKEN_A,
  appRequestBody,
  createHarness,
  deferred,
  flush,
  jsonResponse,
  sseEvent,
  sseResponse,
  type UpstreamHandler,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S1）「保存もログ出力もしない」（クリティカル設計決定 6）。
 * 要求と模擬の上流の応答に目印の文字列を入れ、ログのポート・`console`・
 * 利用量の保存先・予約・中継自身のエラーの応答に現れないことを確かめる。
 */

const MARKER = "MARKER-7f3a9c-推論内容";

function markedRequest(stream: boolean): Record<string, unknown> {
  return appRequestBody({
    stream,
    system: `system ${MARKER}`,
    messages: [
      { role: "user", content: [{ type: "text", text: `user ${MARKER}` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "set_task", input: { title: MARKER } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `result ${MARKER}` }] },
    ],
    tools: [{ name: "set_task", description: `tool ${MARKER}`, input_schema: { type: "object" } }],
  });
}

const streamingUpstream: UpstreamHandler = () =>
  sseResponse(
    [
      sseEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } }),
      sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `answer ${MARKER}` } }),
      sseEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "set_task", input: {} } }),
      sseEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"title":"${MARKER}"}` } }),
      sseEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
      sseEvent({ type: "message_stop" }),
    ].join(""),
  );

const nonStreamingUpstream: UpstreamHandler = () =>
  jsonResponse({
    id: "msg_1",
    type: "message",
    content: [
      { type: "text", text: `answer ${MARKER}` },
      { type: "tool_use", id: "toolu_2", name: "set_task", input: { title: MARKER } },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  });

const errorUpstream: UpstreamHandler = () =>
  jsonResponse({ type: "error", error: { type: "invalid_request_error", message: `bad ${MARKER}` } }, 400);

const CASES: Array<[string, boolean, UpstreamHandler]> = [
  ["ストリーミング", true, streamingUpstream],
  ["非ストリーミング", false, nonStreamingUpstream],
  ["上流が 2xx 以外", false, errorUpstream],
];

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const;

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function consoleArguments(): string {
  return JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String))));
}

describe.each(CASES)("%s", (_label, stream, upstream) => {
  async function runThrough() {
    const h = createHarness({ upstream });
    const response = await h.send(markedRequest(stream));
    await response.text();
    await flush();
    return h;
  }

  it("ログのポートが受けたどの記録にも目印・事業者のキー・アプリのトークンが現れない", async () => {
    const h = await runThrough();
    expect(h.logs.length).toBeGreaterThan(0);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(TEST_OPERATOR_KEY);
    expect(logged).not.toContain(TOKEN_A);
  });

  it("console のどのメソッドにも目印を含む引数が渡らない", async () => {
    await runThrough();
    expect(consoleArguments()).not.toContain(MARKER);
  });

  it("利用量の保存先のどの記録にも目印が現れない", async () => {
    const h = await runThrough();
    expect(JSON.stringify(h.store.dump())).not.toContain(MARKER);
  });

  it("上流の応答を保留した時点で、予約のどれにも目印が現れない", async () => {
    const pending = deferred<Response>();
    const h = createHarness({ upstream: () => pending.promise });
    const responsePromise = h.send(markedRequest(stream));
    await flush();
    const { reservations } = h.store.dump();
    expect(reservations).toHaveLength(1);
    expect(JSON.stringify(reservations)).not.toContain(MARKER);
    pending.resolve(await upstream({} as never));
    await (await responsePromise).text();
  });
});

describe("拒否の経路のログ", () => {
  const REJECTED_TOKEN = "app-token-REJECTED-9999";

  it.each([
    ["401（認証のポートが拒否したトークン）", {}, REJECTED_TOKEN, 401],
    ["413", { maxRequestBytes: 10 }, TOKEN_A, 413],
    ["400", { maxTokensCap: 1 }, TOKEN_A, 400],
    ["429（金額）", { dailyLimit: 0 }, TOKEN_A, 429],
    ["429（同時要求数）", { maxConcurrentRequests: 1 }, TOKEN_A, 429],
  ] as const)("%s のログにも目印・事業者のキー・アプリのトークンが現れない", async (_label, config, token, status) => {
    const pending = deferred<Response>();
    const h = createHarness({ config, upstream: () => pending.promise });
    if (status === 429 && "maxConcurrentRequests" in config) {
      void h.send(markedRequest(false));
      await flush();
    }
    const response = await h.send(markedRequest(false), { token });
    expect(response.status).toBe(status);
    expect(h.logs.some((record) => record.event === "rejected")).toBe(true);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(TEST_OPERATOR_KEY);
    expect(logged).not.toContain(token);
    expect(consoleArguments()).not.toContain(token);
  });
});

describe("中継自身が作る応答", () => {
  it("目印を含む要求を検査で拒否した 400 の本文に目印が現れない（項目名に入れても）", async () => {
    const h = createHarness();
    const response = await h.send({ ...markedRequest(false), [MARKER]: MARKER });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(MARKER);
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
    expect(consoleArguments()).not.toContain(MARKER);
  });

  it("目印を含む要求が壊れた JSON のとき、400 の本文に目印の断片が現れない", async () => {
    const h = createHarness();
    const response = await h.send(`{"system":"${MARKER}",`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(MARKER);
  });

  it("上流のポートの例外の message に目印があっても、502 の本文・ログ・console に現れない", async () => {
    const h = createHarness({
      upstream: () => {
        throw new Error(`failure ${MARKER}`);
      },
    });
    const response = await h.send(markedRequest(false));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(MARKER);
    await flush();
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
    expect(consoleArguments()).not.toContain(MARKER);
  });

  it("利用量のポートの例外の message に目印があっても、500 の本文・ログ・console に現れない", async () => {
    const h = createHarness();
    h.store.reserve = async () => {
      throw new Error(`store failure ${MARKER}`);
    };
    const response = await h.send(markedRequest(false));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(MARKER);
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
    expect(consoleArguments()).not.toContain(MARKER);
  });
});
