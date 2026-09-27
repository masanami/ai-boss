import { describe, expect, it } from "vitest";
import {
  ACCOUNT_A,
  TOKEN_B,
  appRequestBody,
  createHarness,
  deferred,
  expectedReservedUnits,
  flush,
  jsonResponse,
  messageJson,
  type Deferred,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S1）「予約と上限」（クリティカル設計決定 4）。
 */

const BODY = appRequestBody({ max_tokens: 1000 });
const BODY_TEXT = JSON.stringify(BODY);
const RESERVED = expectedReservedUnits(BODY_TEXT, 1000);

async function limitError(response: Response): Promise<{ type: string; limit?: string }> {
  return ((await response.json()) as { error: { type: string; limit?: string } }).error;
}

/** 上流の応答を保留する（呼ばれるたびに保留の応答を 1 つ作る）。 */
function holdingUpstream() {
  const held: Array<Deferred<Response>> = [];
  return {
    held,
    handler: () => {
      const pending = deferred<Response>();
      held.push(pending);
      return pending.promise;
    },
  };
}

describe("予約額", () => {
  it("本文 B バイト・max_tokens M の予約額は (ceil(B×1)×1.25 + M×5) ÷ 1,000,000（保留中に観測）", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ upstream: upstream.handler });
    const responsePromise = h.send(BODY_TEXT);
    await flush();
    const { reservations } = h.store.dump();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].units).toBe(RESERVED);
    expect((await h.usage()).reservedDayUnits).toBe(RESERVED);
    upstream.held[0].resolve(jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })));
    await (await responsePromise).text();
  });

  it("組み立て直した本文が元の本文より大きいとき（数値の表記の展開）は、大きいほうのバイト数で見積もる", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ upstream: upstream.handler });
    const numbers = Array.from({ length: 50 }, () => "1e20").join(",");
    const raw = `{"model":"ai-boss-plan-default","max_tokens":10,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"n","input":{"a":[${numbers}]}}]}]}`;
    void h.send(raw);
    await flush();
    const forwarded = h.calls[0].bodyText;
    expect(forwarded.length).toBeGreaterThan(raw.length);
    expect(h.store.dump().reservations[0].units).toBe(expectedReservedUnits(forwarded, 10));
  });

  it("予約の期限は予約の時刻 ＋ reservationTtlMs", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ upstream: upstream.handler, now: new Date("2026-09-15T12:00:00Z"), config: { reservationTtlMs: 90_000 } });
    void h.send(BODY_TEXT);
    await flush();
    expect(h.store.dump().reservations[0].expiresAt.toISOString()).toBe("2026-09-15T12:01:30.000Z");
  });
});

describe("金額の上限", () => {
  it.each([
    ["dailyLimit", "daily"],
    ["monthlyLimit", "monthly"],
  ] as const)("確定額＋予約額＋この要求の予約額が %s を超えると 429、ちょうどなら転送される", async (limitName, limit) => {
    // 1 件目で確定額を RESERVED（実額を予約額と同じにする）にし、2 件目で判定する。
    const exact = createHarness({ config: { [limitName]: RESERVED * 2 }, upstream: () => jsonResponse({}) });
    expect((await exact.send(BODY_TEXT)).status).toBe(200);
    await flush();
    expect((await exact.usage()).dayUnits).toBe(RESERVED);
    expect((await exact.send(BODY_TEXT)).status).toBe(200);
    expect(exact.calls).toHaveLength(2);

    const over = createHarness({ config: { [limitName]: RESERVED * 2 - 1e-9 }, upstream: () => jsonResponse({}) });
    expect((await over.send(BODY_TEXT)).status).toBe(200);
    await flush();
    const response = await over.send(BODY_TEXT);
    expect(response.status).toBe(429);
    expect(over.calls).toHaveLength(1);
    const error = await limitError(response);
    expect(error.type).toBe("usage_limit_exceeded");
    expect(error.limit).toBe(limit);
    expect(response.headers.has("retry-after")).toBe(false);
  });

  it("未精算の予約額も合計に入る（保留中の 1 件と合わせて超えると 429）", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { dailyLimit: RESERVED * 2 - 1e-9 }, upstream: upstream.handler });
    void h.send(BODY_TEXT);
    await flush();
    const response = await h.send(BODY_TEXT);
    expect(response.status).toBe(429);
    expect((await limitError(response)).limit).toBe("daily");
  });

  it("日と月の両方の上限を超える要求の error.limit は monthly", async () => {
    const h = createHarness({ config: { dailyLimit: RESERVED / 2, monthlyLimit: RESERVED / 2 } });
    const response = await h.send(BODY_TEXT);
    expect(response.status).toBe(429);
    expect(await limitError(response)).toMatchObject({ type: "usage_limit_exceeded", limit: "monthly" });
    expect(h.calls).toHaveLength(0);
  });

  it("金額の上限で拒否した要求は予約も記録も残さない", async () => {
    const h = createHarness({ config: { dailyLimit: RESERVED / 2 } });
    await h.send(BODY_TEXT);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("前日に 1 日の上限に達したアカウントの要求は、UTC の 0 時以降は転送される", async () => {
    const h = createHarness({
      now: new Date("2026-09-30T23:59:58Z"),
      config: { dailyLimit: RESERVED },
      upstream: () => jsonResponse({}),
    });
    expect((await h.send(BODY_TEXT)).status).toBe(200);
    await flush();
    h.clock.current = new Date("2026-09-30T23:59:59Z");
    expect((await h.send(BODY_TEXT)).status).toBe(429);
    h.clock.current = new Date("2026-10-01T00:00:00Z");
    expect((await h.send(BODY_TEXT)).status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });

  it("dailyLimit が予約額の 2 倍以上 3 倍未満で 3 件を同時に送ると、転送は 2 件・429 は 1 件", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { dailyLimit: RESERVED * 2.5, maxConcurrentRequests: 3 }, upstream: upstream.handler });
    const responses = [h.send(BODY_TEXT), h.send(BODY_TEXT), h.send(BODY_TEXT)];
    await flush();
    expect(h.calls).toHaveLength(2);
    for (const pending of upstream.held) pending.resolve(jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })));
    const statuses = await Promise.all(responses.map(async (response) => (await response).status));
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    const rejected = await Promise.all(
      responses.map(async (response) => {
        const r = await response;
        return r.status === 429 ? (await limitError(r)).type : null;
      }),
    );
    expect(rejected.filter((type) => type === "usage_limit_exceeded")).toHaveLength(1);
  });

  it("予約が通った要求は、実額が予約額を上回っても最後まで返り、実額で記録する", async () => {
    const h = createHarness({
      config: { dailyLimit: RESERVED },
      upstream: () => jsonResponse(messageJson({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "full answer")),
    });
    const response = await h.send(BODY_TEXT);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("full answer");
    await flush();
    const [record] = h.store.dump().records;
    expect(record.units).toBe(6);
    expect(record.units).toBeGreaterThan(RESERVED);
  });
});

describe("同時要求数の上限", () => {
  it("maxConcurrentRequests が 2 で、保留中に 3 件目を送ると rate_limit_error・retry-after: 1 の 429 で、上流は 3 件目を受けない", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { maxConcurrentRequests: 2 }, upstream: upstream.handler });
    void h.send(BODY_TEXT);
    void h.send(BODY_TEXT);
    await flush();
    const response = await h.send(BODY_TEXT);
    expect(response.status).toBe(429);
    expect((await limitError(response)).type).toBe("rate_limit_error");
    expect(response.headers.get("retry-after")).toBe("1");
    expect(h.calls).toHaveLength(2);
  });

  it("保留していた 1 件が終わると、次の要求は転送される", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { maxConcurrentRequests: 2 }, upstream: upstream.handler });
    const first = h.send(BODY_TEXT);
    void h.send(BODY_TEXT);
    await flush();
    expect((await h.send(BODY_TEXT)).status).toBe(429);
    upstream.held[0].resolve(jsonResponse(messageJson({ input_tokens: 1, output_tokens: 1 })));
    await (await first).text();
    await flush();
    const third = h.send(BODY_TEXT);
    await flush();
    expect(h.calls).toHaveLength(3);
    upstream.held[2].resolve(jsonResponse({}));
    expect((await third).status).toBe(200);
  });

  it("同時要求数と金額の両方の上限で失敗する要求は usage_limit_exceeded", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { maxConcurrentRequests: 1, dailyLimit: RESERVED * 1.5 }, upstream: upstream.handler });
    void h.send(BODY_TEXT);
    await flush();
    const response = await h.send(BODY_TEXT);
    expect(response.status).toBe(429);
    expect((await limitError(response)).type).toBe("usage_limit_exceeded");
  });

  it("別のアカウントの未精算の予約は、金額と同時要求数の判定に影響しない", async () => {
    const upstream = holdingUpstream();
    const h = createHarness({ config: { maxConcurrentRequests: 1, dailyLimit: RESERVED }, upstream: upstream.handler });
    void h.send(BODY_TEXT);
    await flush();
    const other = h.send(BODY_TEXT, { token: TOKEN_B });
    await flush();
    expect(h.calls).toHaveLength(2);
    upstream.held[1].resolve(jsonResponse({}));
    expect((await other).status).toBe(200);
    expect((await h.usage(ACCOUNT_A)).openReservations).toBe(1);
  });
});
