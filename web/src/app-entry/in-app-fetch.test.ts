// @vitest-environment node
//
// jsdom はグローバルの AbortController/AbortSignal を DOM 実装で上書きし、
// Node 組み込みの fetch/Request が内部で持つ AbortSignal（別クラス）とは
// instanceof が一致しなくなる（実測: 2026-09-28）。このファイルは DOM を
// 使わないので node 環境で実行し、fetch/Request/AbortController を単一の
// 実装（Node 組み込み）に揃える。
import { describe, expect, it, vi } from "vitest";
import { installInAppApi } from "./in-app-fetch";
import type { InAppFetchTarget } from "./in-app-fetch";

const LOCATION = { protocol: "http:", host: "localhost:1420", origin: "http://localhost:1420" };

// 製品版の実運用環境の起点（Tauri。`tauri:` は WHATWG URL の
// "special scheme" 一覧に無い非特別スキーム）。`origin` の直列化表現は
// スキームによらず常に `"null"` になるため、ここでは同一性比較に使わない
// （self-review: code-reviewer, PLAUSIBLE — protocol/host 比較で固定する）。
const TAURI_LOCATION = { protocol: "tauri:", host: "localhost" };

function createFakeApp(response: Response): { app: InAppFetchTarget; fetchSpy: ReturnType<typeof vi.fn> } {
  const fetchSpy = vi.fn(async () => response);
  return { app: { fetch: fetchSpy }, fetchSpy };
}

describe("installInAppApi", () => {
  it("routes a same-origin /api/health request to the app instead of the original fetch (受入基準 S2)", async () => {
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn();

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    await wrappedFetch(`${LOCATION.origin}/api/health`);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(originalFetch).not.toHaveBeenCalled();
  });

  it.each(["/apix", "/index.html"])(
    "routes a same-origin non-/api path (%s) to the original fetch",
    async (path) => {
      const { app, fetchSpy } = createFakeApp(new Response("ok"));
      const originalFetch = vi.fn(async () => new Response("original"));

      const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
      await wrappedFetch(`${LOCATION.origin}${path}`);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(originalFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("routes a cross-origin /api/x request to the original fetch", async () => {
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn(async () => new Response("original"));

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    await wrappedFetch("https://example.com/api/x");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves method, headers, and JSON body for a routed POST request", async () => {
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn();

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    await wrappedFetch(`${LOCATION.origin}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "テストタスク" }),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetchSpy.mock.calls[0][0] as Request;
    expect(forwardedRequest.method).toBe("POST");
    expect(forwardedRequest.headers.get("Content-Type")).toBe("application/json");
    expect(await forwardedRequest.json()).toEqual({ title: "テストタスク" });
  });

  it("aborts the request the app receives when the caller's signal is aborted", async () => {
    let receivedSignal: AbortSignal | undefined;
    const app: InAppFetchTarget = {
      fetch: async (request) => {
        receivedSignal = request.signal;
        return new Response("ok");
      },
    };
    const originalFetch = vi.fn();
    const controller = new AbortController();

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    await wrappedFetch(`${LOCATION.origin}/api/health`, { signal: controller.signal });

    expect(receivedSignal?.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("streams the response body incrementally without buffering it whole", async () => {
    let pushSecondChunk: (() => void) | undefined;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("first-chunk"));
        pushSecondChunk = () => {
          controller.enqueue(encoder.encode("second-chunk"));
          controller.close();
        };
      },
    });
    const app: InAppFetchTarget = {
      fetch: async () => new Response(body),
    };
    const originalFetch = vi.fn();

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    const response = await wrappedFetch(`${LOCATION.origin}/api/sessions/1/messages`);
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first-chunk");
    expect(first.done).toBe(false);

    // 2つ目の断片はまだ送られていない — 呼び出し元は最初の断片を読めている。
    pushSecondChunk!();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second-chunk");
  });

  // self-review（code-reviewer, PLAUSIBLE）: `tauri:` は非特別スキームで、
  // `URL#origin` は常に `"null"` に直列化される（スキームが違っても同じ
  // `"null"` になり、`origin` の文字列比較では区別できない）。実運用の起点
  // （`tauri://localhost`）を模した `location` で、相対パスの要求が正しく
  // 同一オリジン・`/api` 配下と判定されることを固定する。
  it("routes a relative-path /api request when running under the tauri: scheme (non-special scheme)", async () => {
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn();

    const wrappedFetch = installInAppApi(app, originalFetch, TAURI_LOCATION);
    await wrappedFetch("/api/health");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(originalFetch).not.toHaveBeenCalled();
    const forwardedRequest = fetchSpy.mock.calls[0][0] as Request;
    expect(forwardedRequest.url).toBe("tauri://localhost/api/health");
  });

  it("does not route a request whose origin merely serializes to the same opaque 'null' origin under a different scheme", async () => {
    // 2つの非特別スキームの URL は、scheme が違えば `protocol`/`host` の比較で
    // 区別できる（`origin` 同士の文字列比較だと両方 "null" で衝突する）。
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn(async () => new Response("original"));

    const wrappedFetch = installInAppApi(app, originalFetch, TAURI_LOCATION);
    await wrappedFetch("other-scheme://localhost/api/health");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  it("does not route a request with the same opaque scheme but a different host", async () => {
    // 同じ非特別スキーム（`tauri:`）でも host が違えば別オリジン。
    // `protocol` だけの比較では区別できない境界（`host` も見る必要がある
    // ことを固定する）。
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalFetch = vi.fn(async () => new Response("original"));

    const wrappedFetch = installInAppApi(app, originalFetch, TAURI_LOCATION);
    await wrappedFetch("tauri://evil.example/api/health");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });

  // self-review（code-reviewer, PLAUSIBLE）: 振り分け判定のために毎回
  // `new Request(input, init)` を組み立てると、`input` が本文付きの既存
  // `Request` のとき、その本文が「使用済み」になり、素通しの経路
  // （`originalFetch(input, init)`）が失敗していた。
  it("passes through an already-constructed Request with a body without consuming it first", async () => {
    const { app, fetchSpy } = createFakeApp(new Response("ok"));
    const originalRequest = new Request("https://example.com/apix", {
      method: "POST",
      body: "unconsumed-body",
    });
    const originalFetch = vi.fn(async (input: RequestInfo | URL) => {
      // 素通しの経路に渡った Request の本文がまだ読めることを確認する
      // （消費済みなら bodyUsed が true になっている）。
      expect((input as Request).bodyUsed).toBe(false);
      return new Response("original");
    });

    const wrappedFetch = installInAppApi(app, originalFetch, LOCATION);
    await wrappedFetch(originalRequest);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalRequest.bodyUsed).toBe(false);
  });
});
