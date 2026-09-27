import { describe, expect, it } from "vitest";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  TOKEN_B,
  appRequestBody,
  byteLength,
  createHarness,
} from "./test-support/relay-harness.js";

/**
 * 受入基準（S1）「認証」「要求の検査」と、#635 のオーナーの決定 1（外部の
 * 内容を取り込むブロックを見積もりの前に拒否する）。
 */

async function errorType(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { type: string } };
  return body.error.type;
}

describe("認証", () => {
  it("authorization ヘッダの無い要求は 401・authentication_error で、上流を呼ばない", async () => {
    const h = createHarness();
    const response = await h.send(appRequestBody(), { token: null });
    expect(response.status).toBe(401);
    expect(await errorType(response)).toBe("authentication_error");
    expect(h.calls).toHaveLength(0);
  });

  it("認証のポートが拒否するトークンは 401・authentication_error で、上流を呼ばない", async () => {
    const h = createHarness();
    const response = await h.send(appRequestBody(), { token: "unknown-token" });
    expect(response.status).toBe(401);
    expect(await errorType(response)).toBe("authentication_error");
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["Bearer の無い値", "app-token-AAAA-1111"],
    ["Basic 認証", "Basic YWJjOmRlZg=="],
    ["空のトークン", "Bearer "],
  ])("authorization の形が違う要求（%s）は 401", async (_label, value) => {
    const h = createHarness();
    const response = await h.send(appRequestBody(), { token: null, headers: { authorization: value } });
    expect(response.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("認証の失敗は本文の大きさより先に判定する（本文が大きすぎても 401）", async () => {
    const h = createHarness({ config: { maxRequestBytes: 10 } });
    const response = await h.send(appRequestBody(), { token: null });
    expect(response.status).toBe(401);
  });

  it("利用量は認証のポートが返したアカウント ID ごとに分けて記録される", async () => {
    const h = createHarness();
    expect((await h.send(appRequestBody())).status).toBe(200);
    expect((await h.usage(ACCOUNT_A)).dayUnits).toBeGreaterThan(0);
    expect(await h.usage(ACCOUNT_B)).toEqual({
      dayUnits: 0,
      monthUnits: 0,
      reservedDayUnits: 0,
      reservedMonthUnits: 0,
      openReservations: 0,
    });
    expect((await h.send(appRequestBody(), { token: TOKEN_B })).status).toBe(200);
    expect((await h.usage(ACCOUNT_B)).dayUnits).toBeGreaterThan(0);
  });
});

describe("要求の検査（400）", () => {
  const rejected: Array<[string, unknown]> = [
    ["最上位に許可リスト外の項目（mcp_servers）", appRequestBody({ mcp_servers: [] })],
    ["最上位に許可リスト外の項目（service_tier）", appRequestBody({ service_tier: "priority" })],
    ["model がプラン込みの既定でない", appRequestBody({ model: "claude-opus-5-5" })],
    ["model が無い", (() => { const b = appRequestBody(); delete b.model; return b; })()],
    ["max_tokens が無い", (() => { const b = appRequestBody(); delete b.max_tokens; return b; })()],
    ["max_tokens が 0", appRequestBody({ max_tokens: 0 })],
    ["max_tokens が負", appRequestBody({ max_tokens: -100000 })],
    ["max_tokens が小数", appRequestBody({ max_tokens: 1.5 })],
    ["max_tokens が文字列", appRequestBody({ max_tokens: "100" })],
    ["max_tokens が null", appRequestBody({ max_tokens: null })],
    ["tools にプロバイダ側で実行されるツール", appRequestBody({ tools: [{ type: "web_search_20250305", name: "web_search" }] })],
    ["stream が真偽値でない", appRequestBody({ stream: "true" })],
    ["本文が JSON の配列", [appRequestBody()]],
    ["thinking がオブジェクトでない", appRequestBody({ thinking: "adaptive" })],
  ];

  it.each(rejected)("%s は 400・invalid_request_error で、上流を呼ばず、予約も記録もしない", async (_label, body) => {
    const h = createHarness();
    const response = await h.send(body);
    expect(response.status).toBe(400);
    expect(await errorType(response)).toBe("invalid_request_error");
    expect(h.calls).toHaveLength(0);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("本文が JSON として解釈できない要求は 400 で、上流を呼ばない", async () => {
    const h = createHarness();
    const response = await h.send("{not json");
    expect(response.status).toBe(400);
    expect(await errorType(response)).toBe("invalid_request_error");
    expect(h.calls).toHaveLength(0);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("UTF-8 として正しくない本文は 400", async () => {
    const h = createHarness();
    const response = await h.app.request("http://relay.test/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer app-token-AAAA-1111" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect(response.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("max_tokens が maxTokensCap を超えると 400、ちょうどなら転送される", async () => {
    const h = createHarness({ config: { maxTokensCap: 4096 } });
    expect((await h.send(appRequestBody({ max_tokens: 4097 }))).status).toBe(400);
    expect(h.calls).toHaveLength(0);
    expect((await h.send(appRequestBody({ max_tokens: 4096 }))).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("max_tokens が 1 の要求は転送される", async () => {
    const h = createHarness();
    expect((await h.send(appRequestBody({ max_tokens: 1 }))).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("tools が type の無い関数ツールだけの要求は転送される", async () => {
    const h = createHarness();
    const tools = [{ name: "set_task", description: "d", input_schema: { type: "object", properties: {} } }];
    expect((await h.send(appRequestBody({ tools }))).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("重複した項目は解釈後の値で検査し、検査した値を上流へ送る", async () => {
    const h = createHarness({ config: { maxTokensCap: 100 } });
    // JSON.parse は後の値を採る。検査（後の値 999）で拒否される。
    const raw = '{"model":"ai-boss-plan-default","max_tokens":50,"max_tokens":999,"messages":[]}';
    expect((await h.send(raw)).status).toBe(400);
    expect(h.calls).toHaveLength(0);
    const ok = '{"model":"ai-boss-plan-default","max_tokens":999,"max_tokens":50,"messages":[]}';
    expect((await h.send(ok)).status).toBe(200);
    expect(h.calls[0].body.max_tokens).toBe(50);
    expect(h.calls[0].bodyText).not.toContain("999");
  });
});

describe("入力量の上限（413）", () => {
  it("本文の UTF-8 のバイト数が maxRequestBytes を超えると 413・request_too_large で、上流を呼ばず予約も記録もしない", async () => {
    const body = JSON.stringify(appRequestBody({ system: "日本語の本文" }));
    const h = createHarness({ config: { maxRequestBytes: byteLength(body) - 1 } });
    const response = await h.send(body);
    expect(response.status).toBe(413);
    expect(await errorType(response)).toBe("request_too_large");
    expect(h.calls).toHaveLength(0);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("maxRequestBytes ちょうど（多バイト文字を含むバイト数）の要求は転送される", async () => {
    const body = JSON.stringify(appRequestBody({ system: "日本語の本文" }));
    const h = createHarness({ config: { maxRequestBytes: byteLength(body) } });
    expect((await h.send(body)).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("入力量の上限は JSON の解釈より前に判定する（壊れた JSON でも大きすぎれば 413）", async () => {
    const h = createHarness({ config: { maxRequestBytes: 5 } });
    expect((await h.send("{not json at all")).status).toBe(413);
  });
});

describe("外部の内容を取り込むブロックの拒否（#635 のオーナーの決定 1）", () => {
  const userContent = (content: unknown) => appRequestBody({ messages: [{ role: "user", content }] });
  const toolResult = (content: unknown) =>
    userContent([{ type: "tool_result", tool_use_id: "toolu_1", content }]);

  const rejected: Array<[string, unknown]> = [
    ["URL の画像", userContent([{ type: "image", source: { type: "url", url: "https://example.test/a.png" } }])],
    ["ファイル参照の画像", userContent([{ type: "image", source: { type: "file", file_id: "file_1" } }])],
    ["URL の文書", userContent([{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }])],
    ["ファイル参照の文書", userContent([{ type: "document", source: { type: "file", file_id: "file_1" } }])],
    ["base64 の画像", userContent([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }])],
    ["base64 の PDF", userContent([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }])],
    ["文字列の文書", userContent([{ type: "document", source: { type: "text", media_type: "text/plain", data: "x" } }])],
    ["検索結果のブロック", userContent([{ type: "search_result", source: "https://example.test", title: "t", content: [] }])],
    ["コンテナへのアップロード", userContent([{ type: "container_upload", file_id: "file_1" }])],
    ["サーバーツールの結果", userContent([{ type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1", content: {} }])],
    ["MCP のツールの結果", userContent([{ type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: [] }])],
    ["tool_result の中の URL の画像", toolResult([{ type: "image", source: { type: "url", url: "https://example.test/a.png" } }])],
    ["tool_result の中のファイル参照の文書", toolResult([{ type: "document", source: { type: "file", file_id: "file_1" } }])],
    ["tool_result の中の検索結果", toolResult([{ type: "search_result", source: "https://example.test", title: "t", content: [] }])],
    ["tool_result の中のツールの参照", toolResult([{ type: "tool_reference", tool_name: "x" }])],
    ["system の中の文書", appRequestBody({ system: [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }] })],
    ["type の無いブロック", userContent([{ text: "no type" }])],
    ["1 時間のキャッシュ", userContent([{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }])],
    ["system の 1 時間のキャッシュ", appRequestBody({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }] })],
    ["tool_result の中の 1 時間のキャッシュ", toolResult([{ type: "text", text: "r", cache_control: { type: "ephemeral", ttl: "1h" } }])],
    ["tool_use の 1 時間のキャッシュ", userContent([{ type: "tool_use", id: "t", name: "n", input: {}, cache_control: { type: "ephemeral", ttl: "1h" } }])],
    ["ツールの 1 時間のキャッシュ", appRequestBody({ tools: [{ name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }] })],
  ];

  it.each(rejected)("%s を含む要求は 400 で、上流を呼ばず、予約も記録もしない", async (_label, body) => {
    const h = createHarness();
    const response = await h.send(body);
    expect(response.status).toBe(400);
    expect(await errorType(response)).toBe("invalid_request_error");
    expect(h.calls).toHaveLength(0);
    expect(h.store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("アプリのチャットの形（text・tool_use・文字列と text の tool_result・thinking・5 分のキャッシュ）は転送される", async () => {
    const h = createHarness();
    const body = appRequestBody({
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "plain string" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "redacted_thinking", data: "r" },
            { type: "text", text: "calling" },
            { type: "tool_use", id: "toolu_1", name: "set_task", input: { title: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
            { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "done" }], is_error: false },
            { type: "text", text: "next", cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
      ],
    });
    expect((await h.send(body)).status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });
});
