import { describe, expect, it } from "vitest";
import {
  ACCOUNT_A,
  TEST_OPERATOR_KEY,
  TOKEN_A,
  appRequestBody,
  createHarness,
  flush,
  jsonResponse,
  type UpstreamHandler,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S2-U・C-155・#642。機能仕様 docs/features/llm-relay-server.md 決定 S2-Q1）:
 * 上流の 401・403 は、上流の本文を返さずに 502 `api_error` へ変える。これで中継の応答の
 * 401 は「中継がアプリのトークンを認証できなかった」ことだけを意味する。
 */

const MARKER = "UPSTREAM-BODY-MARKER-9e2c";
const CHAT = appRequestBody();

const upstreamAuthFailure = (status: number): UpstreamHandler => () =>
  jsonResponse({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${MARKER}` } }, status, {
    "request-id": "req_upstream_auth",
  });

describe.each([401, 403])("上流が %i を返すとき", (status) => {
  async function run(stream = false) {
    const h = createHarness({ upstream: upstreamAuthFailure(status) });
    const response = await h.send(appRequestBody({ stream }));
    const text = await response.text();
    await flush();
    return { h, response, text };
  }

  it("中継の応答のステータスは 502 である", async () => {
    const { response } = await run();
    expect(response.status).toBe(502);
  });

  it("ストリーミングの要求でも 502 である", async () => {
    const { response } = await run(true);
    expect(response.status).toBe(502);
  });

  it("中継の応答の本文の error.type は api_error で、固定の文言である", async () => {
    const { text } = await run();
    const body = JSON.parse(text) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toBe("The relay could not complete the request.");
  });

  it("中継の応答の本文・ヘッダに上流の本文（目印）・上流の request-id・事業者のキーが現れない", async () => {
    const { response, text } = await run();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(TEST_OPERATOR_KEY);
    expect(JSON.stringify([...response.headers])).not.toContain("req_upstream_auth");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("利用量を記録せず、そのアカウントの未精算の予約は 0 件である", async () => {
    const { h } = await run();
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
    expect(await h.usage(ACCOUNT_A)).toEqual({
      dayUnits: 0,
      monthUnits: 0,
      reservedDayUnits: 0,
      reservedMonthUnits: 0,
      openReservations: 0,
    });
  });

  it("ログのポートは upstream_auth_rejected のイベントを、上流のステータスとともに受ける", async () => {
    const { h } = await run();
    const events = h.logs.filter((record) => record.event === "upstream_auth_rejected");
    expect(events).toEqual([{ event: "upstream_auth_rejected", status }]);
  });

  it("ログのポートが受けたどの記録にも、目印・事業者のキー・アプリのトークンの文字列が現れない", async () => {
    const { h } = await run();
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain(TEST_OPERATOR_KEY);
    expect(logged).not.toContain(TOKEN_A);
  });

  it("再試行（同じ要求を続けて送る）でも、利用者の枠は減らない（毎回予約を解放する）", async () => {
    const h = createHarness({ upstream: upstreamAuthFailure(status) });
    for (let i = 0; i < 3; i++) {
      const response = await h.send(CHAT);
      expect(response.status).toBe(502);
      await response.text();
    }
    await flush();
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });
});

describe("上流の他のステータスと、中継自身の認証", () => {
  it.each([400, 413, 429, 529])("上流の %i は従来どおりステータスと本文が変わらずに返る", async (status) => {
    const upstreamText = JSON.stringify({ type: "error", error: { type: "some_error", message: MARKER } });
    const h = createHarness({
      upstream: () => new Response(upstreamText, { status, headers: { "content-type": "application/json" } }),
    });
    const response = await h.send(CHAT);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(upstreamText);
    expect(h.logs.some((record) => record.event === "upstream_auth_rejected")).toBe(false);
  });

  it("中継自身の認証の失敗は従来どおり 401 authentication_error である（上流は呼ばれない）", async () => {
    const h = createHarness();
    const noToken = await h.send(CHAT, { token: null });
    const badToken = await h.send(CHAT, { token: "not-a-registered-token" });
    for (const response of [noToken, badToken]) {
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { type: string } };
      expect(body.error.type).toBe("authentication_error");
    }
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((record) => record.event === "upstream_auth_rejected")).toBe(false);
  });
});
