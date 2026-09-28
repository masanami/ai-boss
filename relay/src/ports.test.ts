import { describe, expect, it } from "vitest";
import { createFetchUpstream } from "./ports.js";

describe("createFetchUpstream", () => {
  it("リダイレクトに従わない（事業者のキーを上流の URL 以外へ送らない）ように fetch を呼び、signal を渡す", async () => {
    const received: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push({ input, init });
      return new Response("{}");
    }) as typeof fetch;
    const controller = new AbortController();
    const request = new Request("https://upstream.test/v1/messages", { method: "POST", body: "{}" });
    await createFetchUpstream(fakeFetch)(request, controller.signal);
    expect(received).toHaveLength(1);
    expect(received[0].input).toBe(request);
    expect(received[0].init?.redirect).toBe("manual");
    expect(received[0].init?.signal).toBe(controller.signal);
  });
});
