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
  sseEvent,
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
    // 0.0035 の整数表現（× 10^10）。
    expect(h.store.dump().records[0].units).toBe(35_000_000);
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

  it("ストリーミングで終端の usage の前に上流との接続が切れると、予約額を記録し、アプリへのストリームはステータスを変えずに異常終了する", async () => {
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
    // 正常な終わりに見せない（PR #638 の代替レビューの指摘 6）。
    await expect(text).rejects.toThrow();
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

describe("PR #638 のレビュー対応", () => {
  describe("予約の時刻（Codex P1）", () => {
    /** 本文の送信が終わる直前に時計を進める（境界の前に開き、後に送り終える要求）。 */
    function sendWithClockAdvance(h: ReturnType<typeof createHarness>, bodyText: string, advanceTo: Date) {
      const encoded = new TextEncoder().encode(bodyText);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          h.clock.current = advanceTo;
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return h.app.request(
        new Request("http://relay.test/v1/messages", {
          method: "POST",
          headers: { authorization: "Bearer app-token-AAAA-1111", "content-type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit),
      );
    }

    it("UTC の日・月の境界の前に開き、境界の後に本文を送り終えた要求は、新しい期間に記録され、期限も予約の時刻から求める", async () => {
      const h = createHarness({ now: new Date("2026-09-30T23:59:59Z"), config: { reservationTtlMs: 60_000 } });
      const pending = deferred<Response>();
      h.setUpstream(() => pending.promise);
      const responsePromise = sendWithClockAdvance(h, JSON.stringify(appRequestBody()), new Date("2026-10-01T00:00:00Z"));
      await flush();
      const [reservation] = h.store.dump().reservations;
      expect(reservation).toMatchObject({ dayKey: "2026-10-01", monthKey: "2026-10" });
      expect(reservation.expiresAt.toISOString()).toBe("2026-10-01T00:01:00.000Z");
      pending.resolve(jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })));
      await drain(await responsePromise);
      expect(h.store.dump().records[0]).toMatchObject({ dayKey: "2026-10-01", monthKey: "2026-10" });
    });

    it("新しい日の上限に達したアカウントは、境界の前に開いた要求でも旧期間の枠で消費できない（429）", async () => {
      const bodyText = JSON.stringify(appRequestBody());
      const reserved = expectedReservedUnits(bodyText, 1000);
      const h = createHarness({
        now: new Date("2026-10-01T00:00:05Z"),
        config: { dailyLimit: reserved / 10_000_000_000 },
        upstream: () => jsonResponse({}),
      });
      // 新しい日の枠を使い切る。
      await drain(await h.send(bodyText));
      h.clock.current = new Date("2026-09-30T23:59:59Z");
      const response = await sendWithClockAdvance(h, bodyText, new Date("2026-10-01T00:00:10Z"));
      expect(response.status).toBe(429);
      expect(h.calls).toHaveLength(1);
    });
  });

  describe("壊れた usage（Codex P2）", () => {
    it.each([
      ["負の数", -5],
      ["文字列", "200"],
      ["null", null],
      ["小数", 1.5],
    ])("最後の message_delta の output_tokens が%sなら、message_start の値を残さず予約額で確定する", async (_label, value) => {
      const events = [
        sseEvent({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }),
        sseEvent({ type: "message_delta", delta: {}, usage: { output_tokens: value } }),
        sseEvent({ type: "message_stop" }),
      ];
      const h = createHarness({ upstream: () => sseResponse(events.join("")) });
      const body = streamingBody();
      await drain(await h.send(body));
      expect(h.store.dump().records).toEqual([
        expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS }),
      ]);
    });

    it("message_delta の usage 自体がオブジェクトでなければ予約額で確定する", async () => {
      const events = [
        sseEvent({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }),
        sseEvent({ type: "message_delta", delta: {}, usage: "broken" }),
        sseEvent({ type: "message_stop" }),
      ];
      const h = createHarness({ upstream: () => sseResponse(events.join("")) });
      await drain(await h.send(streamingBody()));
      expect(h.store.dump().records[0]).toMatchObject(ZERO_TOKENS);
    });

    it.each([
      ["JSON として解釈できない", "data: {not json\n\n"],
      ["JSON だがオブジェクトでない", "data: 42\n\n"],
    ])("正しい usage の後に%sイベントが来たら、終端まで届いても予約額で確定する（Codex 2 巡目 P2）", async (_label, broken) => {
      const events = [
        sseEvent({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1 } } }),
        sseEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 200 } }),
        broken,
        sseEvent({ type: "message_stop" }),
      ];
      const h = createHarness({ upstream: () => sseResponse(events.join("")) });
      const body = streamingBody();
      await drain(await h.send(body));
      expect(h.store.dump().records).toEqual([
        expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS }),
      ]);
    });

    it("非ストリーミングでキャッシュの項目が壊れていれば（0 として数えず）予約額で確定する", async () => {
      const h = createHarness({
        upstream: () => jsonResponse(messageJson({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: -1 })),
      });
      const body = appRequestBody();
      await drain(await h.send(body));
      expect(h.store.dump().records[0]).toMatchObject({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS });
    });

    it("キャッシュの項目の null・usage の無い message_delta は壊れた値とみなさない", async () => {
      const events = [
        sseEvent({ type: "message_start", message: { usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: null } } }),
        sseEvent({ type: "message_delta", delta: {} }),
        sseEvent({ type: "message_delta", delta: {}, usage: { output_tokens: 200, cache_creation_input_tokens: null } }),
        sseEvent({ type: "message_stop" }),
      ];
      const h = createHarness({ upstream: () => sseResponse(events.join("")) });
      await drain(await h.send(streamingBody()));
      expect(h.store.dump().records[0]).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0 });
    });
  });

  describe("上流のリダイレクト（指摘 3）", () => {
    it.each([301, 302, 307, 308])("上流が %s を返すと、location を通さず 502 にし、予約を解放して記録しない", async (status) => {
      const h = createHarness({
        upstream: () => new Response(null, { status, headers: { location: "https://elsewhere.test/steal" } }),
      });
      const response = await h.send(appRequestBody());
      expect(response.status).toBe(502);
      expect(response.headers.has("location")).toBe(false);
      expect(await response.text()).not.toContain("elsewhere.test");
      expect(h.store.dump()).toEqual({ records: [], reservations: [] });
    });
  });

  describe("予約の後の想定外の例外（指摘 4）", () => {
    it("上流を呼んだ後に例外が起きると（本文が読めない）、予約額で確定して予約を残さず、500 を返す", async () => {
      const h = createHarness({
        upstream: () => {
          const response = sseResponse("event: ping\ndata: {}\n\n");
          response.body!.getReader(); // 本文をロックして、中継の getReader を失敗させる
          return response;
        },
      });
      const body = streamingBody();
      const response = await h.send(body);
      expect(response.status).toBe(500);
      const { records, reservations } = h.store.dump();
      expect(reservations).toEqual([]);
      expect(records).toEqual([expect.objectContaining({ units: expectedReservedUnits(JSON.stringify(body), 1000), ...ZERO_TOKENS })]);
    });
  });
});
