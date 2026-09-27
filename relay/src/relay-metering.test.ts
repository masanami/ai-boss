import { describe, expect, it } from "vitest";
import { UpstreamFailure } from "./ports.js";
import {
  ACCOUNT_A,
  appRequestBody,
  createControlledBody,
  createHarness,
  deferred,
  expectedReservedUnits,
  flush,
  jsonResponse,
  messageJson,
  sseResponse,
  sseTranscript,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S1）「利用量の計測」（クリティカル設計決定 2・4）。
 */

const ZERO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function streamingBody(overrides: Record<string, unknown> = {}) {
  return appRequestBody({ stream: true, ...overrides });
}

async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
  await flush();
}

describe("usage の読み取りと原価単位", () => {
  it("ストリーミングの message_start の input_tokens と、最後の message_delta の output_tokens を記録する", async () => {
    const h = createHarness({ upstream: () => sseResponse(sseTranscript({ inputTokens: 1000, outputTokens: [200] }).join("")) });
    await drain(await h.send(streamingBody()));
    const [record] = h.store.dump().records;
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(200);
  });

  it("message_delta が 2 回届いたら、出力トークンは最後の値", async () => {
    const h = createHarness({ upstream: () => sseResponse(sseTranscript({ inputTokens: 1000, outputTokens: [50, 200] }).join("")) });
    await drain(await h.send(streamingBody()));
    expect(h.store.dump().records[0].outputTokens).toBe(200);
  });

  it("SSE の断片がイベントや行の途中で切れていても、同じ usage を読む", async () => {
    const text = sseTranscript({ inputTokens: 1000, outputTokens: [200] }).join("").replace(/\n/g, "\r\n");
    const h = createHarness({
      upstream: () => {
        const body = createControlledBody();
        for (let i = 0; i < text.length; i += 7) body.push(text.slice(i, i + 7));
        body.close();
        return sseResponse(body.stream);
      },
    });
    await drain(await h.send(streamingBody()));
    expect(h.store.dump().records[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it("非ストリーミングの応答の usage を記録する", async () => {
    const h = createHarness({
      upstream: () =>
        jsonResponse(
          messageJson({ input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 56, cache_creation_input_tokens: 78 }),
        ),
    });
    await drain(await h.send(appRequestBody()));
    expect(h.store.dump().records[0]).toMatchObject({
      accountId: ACCOUNT_A,
      inputTokens: 12,
      outputTokens: 34,
      cacheReadInputTokens: 56,
      cacheCreationInputTokens: 78,
    });
  });

  it("入力 1,000・出力 200・キャッシュ読み出し 10,000・キャッシュ書き込み 400 の原価単位は 0.0035", async () => {
    const h = createHarness({
      upstream: () =>
        jsonResponse(
          messageJson({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 400 }),
        ),
    });
    await drain(await h.send(appRequestBody()));
    expect(h.store.dump().records[0].units).toBeCloseTo(0.0035, 12);
  });
});

describe("記録しない・予約額で確定する", () => {
  it("上流が 2xx 以外を返した要求は記録せず、未精算の予約も残らない", async () => {
    const h = createHarness({ upstream: () => jsonResponse({ type: "error", error: { type: "overloaded_error" } }, 529) });
    await drain(await h.send(appRequestBody()));
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("上流のポートが「送る前の失敗」を投げた要求（502）は記録せず、未精算の予約も残らない", async () => {
    const h = createHarness({
      upstream: () => {
        throw new UpstreamFailure("before-send");
      },
    });
    const response = await h.send(appRequestBody());
    expect(response.status).toBe(502);
    await flush();
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it.each([
    ["「送った後の失敗」", () => new UpstreamFailure("after-send")],
    ["区分の無い例外", () => new TypeError("socket hang up")],
  ])("上流のポートが%sを投げた要求（502）は予約額を記録し、未精算の予約は残らない", async (_label, makeError) => {
    const h = createHarness({
      upstream: () => {
        throw makeError();
      },
    });
    const body = appRequestBody();
    const response = await h.send(body);
    expect(response.status).toBe(502);
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS });
  });

  it("上流の応答ヘッダが届く前にアプリが中止した要求は予約額を記録する", async () => {
    const pending = deferred<Response>();
    const h = createHarness({
      upstream: (call) => {
        call.signal.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")));
        return pending.promise;
      },
    });
    const app = new AbortController();
    const body = appRequestBody();
    const responsePromise = h.send(body, { signal: app.signal });
    await flush();
    app.abort();
    await responsePromise;
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
  });

  it("ストリーミングで終端の usage の前にアプリが中止すると、途中の usage ではなく予約額を記録し、予約は残らない", async () => {
    const h = createHarness({
      upstream: (call) => {
        const body = createControlledBody(call.signal);
        const events = sseTranscript({ inputTokens: 1000, outputTokens: [200], terminal: false });
        for (const event of events) body.push(event);
        return sseResponse(body.stream);
      },
    });
    const body = streamingBody();
    const response = await h.send(body);
    const reader = response.body!.getReader();
    await reader.read();
    await flush();
    await reader.cancel();
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
  });

  it("ストリーミングで終端の usage の前に要求の signal でアプリが中止しても、予約額を記録する", async () => {
    const h = createHarness({
      upstream: (call) => {
        const body = createControlledBody(call.signal);
        for (const event of sseTranscript({ inputTokens: 1000, outputTokens: [200], terminal: false })) body.push(event);
        return sseResponse(body.stream);
      },
    });
    const app = new AbortController();
    const body = streamingBody();
    const response = await h.send(body, { signal: app.signal });
    const reader = response.body!.getReader();
    await reader.read();
    app.abort();
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000) })]);
  });

  it("ストリーミングで終端の usage の前に上流との接続が切れると、予約額を記録し、アプリへのストリームはステータスを変えずに終わる", async () => {
    let upstreamBody!: ReturnType<typeof createControlledBody>;
    const h = createHarness({
      upstream: () => {
        upstreamBody = createControlledBody();
        for (const event of sseTranscript({ inputTokens: 1000, outputTokens: [200], terminal: false })) upstreamBody.push(event);
        return sseResponse(upstreamBody.stream);
      },
    });
    const body = streamingBody();
    const response = await h.send(body);
    expect(response.status).toBe(200);
    const text = response.text();
    await flush();
    upstreamBody.fail();
    await text;
    await flush();
    const { records, reservations } = h.store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
  });

  it("終端（message_stop）まで受け取った後にアプリが中止しても、終端の usage で精算する", async () => {
    let upstreamBody!: ReturnType<typeof createControlledBody>;
    const h = createHarness({
      upstream: (call) => {
        upstreamBody = createControlledBody(call.signal);
        for (const event of sseTranscript({ inputTokens: 1000, outputTokens: [200] })) upstreamBody.push(event);
        return sseResponse(upstreamBody.stream);
      },
    });
    const response = await h.send(streamingBody());
    const reader = response.body!.getReader();
    await flush();
    await reader.cancel();
    await flush();
    expect(h.store.dump().records).toEqual([expect.objectContaining({ inputTokens: 1000, outputTokens: 200 })]);
  });

  it.each([
    ["非ストリーミング", () => jsonResponse({ id: "msg_1", content: [] }), appRequestBody()],
    ["ストリーミング", () => sseResponse('event: message_stop\ndata: {"type":"message_stop"}\n\n'), streamingBody()],
    ["壊れた usage", () => jsonResponse(messageJson({ input_tokens: -5, output_tokens: 3 })), appRequestBody()],
  ])("上流が 2xx を返したのに usage が無いまま終わると（%s）、予約額を記録しトークン数は 0", async (_label, upstream, body) => {
    const h = createHarness({ upstream });
    await drain(await h.send(body));
    expect(h.store.dump().records).toEqual([
      expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS }),
    ]);
  });
});

describe("期間キー（UTC）", () => {
  it.each([
    ["2026-09-30T23:59:59Z", "2026-09-30", "2026-09"],
    ["2026-10-01T00:00:00Z", "2026-10-01", "2026-10"],
  ])("時計が %s のときの要求は日 %s・月 %s に記録される", async (now, dayKey, monthKey) => {
    const h = createHarness({ now: new Date(now) });
    await drain(await h.send(appRequestBody()));
    expect(h.store.dump().records[0]).toMatchObject({ dayKey, monthKey });
  });

  it("23:59:59Z に予約し 00:00:01Z に終わった要求は、予約した日・月に記録される", async () => {
    const pending = deferred<Response>();
    const h = createHarness({ now: new Date("2026-09-30T23:59:59Z"), upstream: () => pending.promise });
    const responsePromise = h.send(appRequestBody());
    await flush();
    h.clock.current = new Date("2026-10-01T00:00:01Z");
    pending.resolve(jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })));
    await drain(await responsePromise);
    expect(h.store.dump().records[0]).toMatchObject({ dayKey: "2026-09-30", monthKey: "2026-09" });
  });
});

describe("精算の実行", () => {
  it("上流へ送る前にアプリが中止していた要求は、上流を呼ばず、記録もせず予約を解放する", async () => {
    const h = createHarness();
    const app = new AbortController();
    const originalReserve = h.store.reserve.bind(h.store);
    // 予約の直後（上流へ送る前）にアプリが中止した状況を作る。
    h.store.reserve = async (request) => {
      const result = await originalReserve(request);
      app.abort();
      return result;
    };
    const response = await h.send(appRequestBody(), { signal: app.signal });
    expect(response.status).toBe(502);
    expect(h.calls).toHaveLength(0);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("ログのポートが例外を投げても、精算は行われ予約は残らない", async () => {
    const h = createHarness({ upstream: () => jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })) });
    const failing = createHarness({ upstream: () => jsonResponse({}, 529) });
    for (const harness of [h, failing]) {
      harness.logs.push = () => {
        throw new Error("logger down");
      };
      const response = await harness.send(appRequestBody());
      await response.text();
      await flush();
      expect(harness.store.dump().reservations).toEqual([]);
    }
    expect(h.store.dump().records).toHaveLength(1);
  });

  it.each([
    ["上流の 2xx 以外", () => jsonResponse({}, 529)],
    [
      "上流のポートの例外",
      () => {
        throw new TypeError("reset");
      },
    ],
  ])("%sの応答は、利用量のポートの精算が終わってから返る", async (_label, upstream) => {
    const h = createHarness({ upstream });
    const gate = deferred<void>();
    const originalSettle = h.store.settle.bind(h.store);
    h.store.settle = async (id, outcome) => {
      await gate.promise;
      return originalSettle(id, outcome);
    };
    let returned = false;
    const responsePromise = h.send(appRequestBody()).then((response) => {
      returned = true;
      return response;
    });
    await flush();
    expect(returned).toBe(false);
    gate.resolve();
    await responsePromise;
    expect(returned).toBe(true);
  });

  it("ストリーミングの応答は、利用量のポートの精算が終わってからアプリへのストリームを閉じる", async () => {
    const h = createHarness({ upstream: () => sseResponse(sseTranscript({ inputTokens: 5, outputTokens: [7] }).join("")) });
    const gate = deferred<void>();
    const originalSettle = h.store.settle.bind(h.store);
    h.store.settle = async (id, outcome) => {
      await gate.promise;
      return originalSettle(id, outcome);
    };
    let ended = false;
    const text = (await h.send(streamingBody())).text().then(() => {
      ended = true;
    });
    await flush();
    expect(ended).toBe(false);
    gate.resolve();
    await text;
    expect(h.store.dump().records).toEqual([expect.objectContaining({ inputTokens: 5, outputTokens: 7 })]);
  });
});
