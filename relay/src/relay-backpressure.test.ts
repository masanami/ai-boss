import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BUFFERED_RESPONSE_BYTES } from "./config.js";
import {
  appRequestBody,
  byteLength,
  createControlledBody,
  createHarness,
  deferred,
  expectedReservedUnits,
  flush,
  messageJson,
  sseEvent,
  sseResponse,
  sseTranscript,
} from "./test-support/relay-harness.js";
import { createJsonUsageMeter, createSseUsageMeter } from "./usage-metering.js";

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

describe("上限より大きい断片（ローカル Codex レビューの指摘 1）", () => {
  /** 精算を保留できる中継。保留中に待ち行列を観測する（中止のエラーは精算の後に出るため）。 */
  function harnessWithHeldSettlement(maxBufferedResponseBytes: number) {
    const { h, state } = harnessWithControlledUpstream(maxBufferedResponseBytes);
    const gate = deferred<void>();
    const settle = h.store.settle.bind(h.store);
    h.store.settle = async (reservationId, outcome) => {
      await gate.promise;
      return settle(reservationId, outcome);
    };
    return { h, state, gate };
  }

  it("上限より大きい断片が 1 つ届いたら、待ち行列に積まずに中止し、予約額で確定する", async () => {
    const { h, state, gate } = harnessWithHeldSettlement(100);
    const body = streamingBody();
    const response = await h.send(body);
    state.body!.push(new Uint8Array(101).fill(0x61));
    await flush();
    expect(state.signal!.aborted).toBe(true);

    // 精算の間も、上限を超える断片は待ち行列に無い（アプリの読み取りに渡らない）。
    let delivered = false;
    const read = response.body!.getReader().read().then((result) => {
      delivered = true;
      return result;
    });
    await flush();
    expect(delivered).toBe(false);
    gate.resolve();
    await expect(read).rejects.toThrow("relay response buffer limit exceeded");
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
  });

  it("上限ちょうどの断片 1 つは待ち行列に積み、後から読んだアプリへ渡す", async () => {
    const { h, state } = harnessWithControlledUpstream(100);
    const response = await h.send(streamingBody());
    state.body!.push(new Uint8Array(100).fill(0x61));
    await flush();
    expect(state.signal!.aborted).toBe(false);
    const { value } = await response.body!.getReader().read();
    expect(value?.byteLength).toBe(100);
  });
});

describe("ストリーミングの計測器の未処理の行・イベントの上限（ローカル Codex レビューの指摘 2）", () => {
  const encoder = new TextEncoder();
  const start = sseEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1000, output_tokens: 1 } } });
  const bigLine = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x".repeat(200) } })}`;
  const rest = [
    "\n\n",
    sseEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } }),
    sseEvent({ type: "message_stop" }),
  ];

  /** 区切りの無い大きな行を送ってから、残りのイベントを送り切る。 */
  function meterResult(maxBytes: number) {
    const meter = createSseUsageMeter(maxBytes);
    for (const text of [start, bigLine, ...rest]) meter.push(encoder.encode(text));
    return meter.result();
  }

  it("区切りを待つ行がちょうど上限なら、終端の usage を読む", () => {
    expect(meterResult(bigLine.length)).toEqual({ ...ZERO_TOKENS, inputTokens: 1000, outputTokens: 200 });
  });

  it("区切りを待つ行が上限を超えたら持つのをやめ、終端まで届いても実額に使わない", () => {
    expect(meterResult(bigLine.length - 1)).toBeNull();
  });

  /** 複数の data の行に分けた（つなげると正しい JSON になる）ping のイベントを挟む。 */
  function multiLineResult(maxBytes: number) {
    const lines = ['{"type":"ping","pad":[', ...Array.from({ length: 20 }, () => "1111111111,"), "1]}"];
    const meter = createSseUsageMeter(maxBytes);
    meter.push(encoder.encode(start));
    for (const line of lines) meter.push(encoder.encode(`data: ${line}\n`));
    for (const text of rest) meter.push(encoder.encode(text));
    // 各行は区切りの "\n" の分（1）も数える。
    return { result: meter.result(), dataLength: lines.reduce((sum, line) => sum + line.length + 1, 0) };
  }

  it("空行の来ないイベントの data の行が積み重なって上限を超えたら、実額に使わない", () => {
    const { dataLength } = multiLineResult(Number.MAX_SAFE_INTEGER);
    // どの行も単独では上限に届かない。
    expect(multiLineResult(dataLength).result).toEqual({ ...ZERO_TOKENS, inputTokens: 1000, outputTokens: 200 });
    expect(multiLineResult(dataLength - 1).result).toBeNull();
  });

  const PING = '{"type":"ping"}';

  /** 空の `data:` 行を `emptyLines` 本続けてから、ping で閉じるイベントを挟む（先頭の改行は JSON として許される）。 */
  function emptyDataLinesResult(maxBytes: number, emptyLines: number) {
    const meter = createSseUsageMeter(maxBytes);
    meter.push(encoder.encode(start));
    for (let i = 0; i < emptyLines; i++) meter.push(encoder.encode("data:\n"));
    meter.push(encoder.encode(`data: ${PING}\n`));
    for (const text of rest) meter.push(encoder.encode(text));
    return meter.result();
  }

  it("空の data の行も区切りの 1 を数える（空行だけを積んでも上限が効く）", () => {
    const emptyLines = 50;
    // 空の行は 1 本につき 1、ping の行は JSON の長さ + 1。
    const dataLength = emptyLines + PING.length + 1;
    expect(emptyDataLinesResult(dataLength, emptyLines)).toEqual({ ...ZERO_TOKENS, inputTokens: 1000, outputTokens: 200 });
    expect(emptyDataLinesResult(dataLength - 1, emptyLines)).toBeNull();
  });

  it("中継は計測器が諦めても、読み続けるアプリへは全部を渡し、予約額で確定する", async () => {
    const { h, state } = harnessWithControlledUpstream(bigLine.length - 1);
    const body = streamingBody();
    const response = await h.send(body);
    const text = response.text();
    for (const chunk of [start, bigLine.slice(0, 100), bigLine.slice(100), ...rest]) {
      state.body!.push(chunk);
      await flush();
    }
    state.body!.close();

    expect(await text).toBe([start, bigLine, ...rest].join(""));
    await flush();
    expect(state.signal!.aborted).toBe(false);
    expect(h.store.dump().records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
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
