import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BUFFERED_RESPONSE_BYTES } from "./config.js";
import {
  appRequestBody,
  byteLength,
  createControlledBody,
  createHarness,
  expectedReservedUnits,
  flush,
  messageJson,
  sseResponse,
  sseTranscript,
} from "./test-support/relay-harness.js";
import { createJsonUsageMeter } from "./usage-metering.js";

/**
 * アプリが読まない応答の待ち行列の上限（#641）。中継は上流を最後まで読むため、
 * アプリが読まない分は中継の内部の待ち行列に積まれる。そのバイト数が
 * `maxBufferedResponseBytes` を超えたら、アプリ側を中止する（アプリの中止と同じ
 * 扱いで上流も止め、終端の `usage` を受け取っていなければ予約額で確定する）。
 */

const ZERO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const MARKER = "BACKPRESSURE-MARKER-8c2e";

function streamingBody() {
  return appRequestBody({ stream: true });
}

/** SSE の本文の断片（本文の目印入り）と、その合計のバイト数。 */
function transcript(terminal = true) {
  const events = sseTranscript({ inputTokens: 1000, outputTokens: [200], text: MARKER.repeat(20), terminal });
  return { events, total: events.reduce((sum, event) => sum + byteLength(event), 0) };
}

/** 断片を押し込める上流を持つ中継。`upstreamSignal` で上流の中止を観測する。 */
function harnessWithControlledUpstream(maxBufferedResponseBytes: number) {
  const state: { body?: ReturnType<typeof createControlledBody>; signal?: AbortSignal } = {};
  const h = createHarness({
    config: { maxBufferedResponseBytes },
    upstream: (call) => {
      state.body = createControlledBody(call.signal);
      state.signal = call.signal;
      return sseResponse(state.body.stream);
    },
  });
  return { h, state };
}

describe("アプリが読まない応答の待ち行列の上限（#641）", () => {
  it("読まないアプリの待ち行列が上限を超えると、アプリへのストリームを異常終了させ、上流を中止し、予約額で確定する", async () => {
    const { events, total } = transcript(false);
    const { h, state } = harnessWithControlledUpstream(total - 1);
    const body = streamingBody();
    const response = await h.send(body);
    expect(response.status).toBe(200);
    for (const event of events) state.body!.push(event);
    await flush();

    expect(state.signal!.aborted).toBe(true);
    await expect(response.body!.getReader().read()).rejects.toThrow("relay response buffer limit exceeded");
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    // 終端の usage を受け取る前に中止したため、途中の usage ではなく予約額で確定する。
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "response_buffer_exceeded", status: 200 }));
    expect(JSON.stringify(h.logs)).not.toContain(MARKER);
  });

  it("終端まで受け取った断片で上限を超えたときは、アプリの中止と同じく終端の usage で精算する", async () => {
    const { events, total } = transcript();
    const { h, state } = harnessWithControlledUpstream(total - 1);
    const response = await h.send(streamingBody());
    for (const event of events) state.body!.push(event);
    await flush();

    expect(state.signal!.aborted).toBe(true);
    await expect(response.body!.getReader().read()).rejects.toThrow("relay response buffer limit exceeded");
    expect(h.store.dump().records).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 200 })]);
  });

  it("待ち行列がちょうど上限なら中止せず、後から読んだアプリへ全部を渡し、終端の usage で精算する", async () => {
    const { events, total } = transcript();
    const { h, state } = harnessWithControlledUpstream(total);
    const response = await h.send(streamingBody());
    for (const event of events) state.body!.push(event);
    state.body!.close();
    await flush();

    expect(state.signal!.aborted).toBe(false);
    expect(await response.text()).toBe(events.join(""));
    await flush();
    expect(h.store.dump().records).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 200 })]);
    expect(h.logs.some((record) => record.event === "response_buffer_exceeded")).toBe(false);
  });

  it("読み続けるアプリは、応答の合計が上限を超えても中止されない（数えるのは待ち行列の長さ）", async () => {
    const { events } = transcript();
    const largest = Math.max(...events.map(byteLength));
    const { h, state } = harnessWithControlledUpstream(largest);
    const response = await h.send(streamingBody());
    const text = response.text();
    for (const event of events) {
      state.body!.push(event);
      await flush();
    }
    state.body!.close();

    expect(await text).toBe(events.join(""));
    await flush();
    expect(state.signal!.aborted).toBe(false);
    expect(h.store.dump().records).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 200 })]);
  });

  it("上限を指定しない設定では既定値（1 MiB）が効く: ちょうどなら中止せず、1 バイト超えたら中止する", async () => {
    expect(DEFAULT_MAX_BUFFERED_RESPONSE_BYTES).toBe(1024 * 1024);
    const state: { body?: ReturnType<typeof createControlledBody>; signal?: AbortSignal } = {};
    const h = createHarness({
      upstream: (call) => {
        state.body = createControlledBody(call.signal);
        state.signal = call.signal;
        return sseResponse(state.body.stream);
      },
    });
    const response = await h.send(streamingBody());
    state.body!.push(new Uint8Array(DEFAULT_MAX_BUFFERED_RESPONSE_BYTES).fill(0x61));
    await flush();
    expect(state.signal!.aborted).toBe(false);
    state.body!.push(new Uint8Array(1).fill(0x61));
    await flush();
    expect(state.signal!.aborted).toBe(true);
    await expect(response.body!.getReader().read()).rejects.toThrow("relay response buffer limit exceeded");
  });
});

describe("非ストリーミングの計測器の本文の上限（#641）", () => {
  const json = JSON.stringify(messageJson({ input_tokens: 10, output_tokens: 5 }));
  const bytes = new TextEncoder().encode(json);

  function meterResult(maxBytes: number) {
    const meter = createJsonUsageMeter(maxBytes);
    const half = Math.floor(bytes.byteLength / 2);
    meter.push(bytes.slice(0, half));
    meter.push(bytes.slice(half));
    return meter.result();
  }

  it("本文がちょうど上限なら usage を読む", () => {
    expect(meterResult(bytes.byteLength)).toEqual({ ...ZERO_TOKENS, inputTokens: 10, outputTokens: 5 });
  });

  it("本文が上限を超えたら持つのをやめ、実額に使わない（null＝予約額で確定）", () => {
    expect(meterResult(bytes.byteLength - 1)).toBeNull();
  });

  it("中継は非ストリーミングの本文が上限を超えても、読み続けるアプリへは全部を渡し、予約額で確定する", async () => {
    const state: { body?: ReturnType<typeof createControlledBody> } = {};
    const h = createHarness({
      config: { maxBufferedResponseBytes: bytes.byteLength - 1 },
      upstream: () => {
        state.body = createControlledBody();
        return new Response(state.body.stream, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const body = appRequestBody();
    const response = await h.send(body);
    const text = response.text();
    const half = Math.floor(bytes.byteLength / 2);
    state.body!.push(bytes.slice(0, half));
    await flush();
    state.body!.push(bytes.slice(half));
    await flush();
    state.body!.close();

    expect(await text).toBe(json);
    await flush();
    expect(h.store.dump().records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
  });
});
