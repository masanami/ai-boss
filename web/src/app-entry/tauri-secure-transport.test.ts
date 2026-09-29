// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SecureTransportError, type SecureTransportErrorKind } from "../../../server/src/core-entry.js";
import {
  createTauriSecureTransport,
  type SecureEventChannel,
  type SecureStreamEvent,
} from "./tauri-secure-transport";

/**
 * 転送のポートの Tauri 実装（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md 受入基準（S3）S3-T1〜S3-T11）。
 * 模擬の `invoke` と模擬の `Channel` で確かめる（コマンドの名前・引数の名前は
 * Rust の `native/tauri-app/tests/secure_commands.rs` と同じ値）。
 */

interface Call {
  command: string;
  args: Record<string, unknown>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 模擬の器。`secure_send` の応答は `respond` で決め、`Channel` へは `emit` で送る。
 */
function fakeTauri(options: { respond?: (call: Call) => Promise<unknown> } = {}) {
  const calls: Call[] = [];
  const channels: SecureEventChannel[] = [];
  let ids = 0;
  const transport = createTauriSecureTransport({
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "secure_cancel") return true;
      return (options.respond ?? (async () => ({ status: 200, headers: {} })))({ command, args });
    },
    createChannel: () => {
      const channel: SecureEventChannel = { onmessage: () => undefined };
      channels.push(channel);
      return channel;
    },
    newRequestId: () => `req-${++ids}`,
  });
  const emit = (event: SecureStreamEvent, index = channels.length - 1) => channels[index]!.onmessage(event);
  const commands = (name: string) => calls.filter((call) => call.command === name);
  return { transport, calls, channels, emit, commands };
}

const request = { destination: "anthropic-messages", headers: { "anthropic-beta": "x" }, body: '{"model":"m"}' };

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return chunks;
}

describe("createTauriSecureTransport", () => {
  it("S3-T1: secure_send を、要求の destination・headers・body と文字列の requestId と Channel で呼ぶ", async () => {
    const tauri = fakeTauri();
    await tauri.transport(request, new AbortController().signal);
    const [send] = tauri.commands("secure_send");
    expect(send!.args).toEqual({
      requestId: expect.any(String),
      destination: "anthropic-messages",
      headers: { "anthropic-beta": "x" },
      body: '{"model":"m"}',
      onEvent: tauri.channels[0],
    });
  });

  it("S3-T2: 2 回送ると requestId は異なる", async () => {
    const tauri = fakeTauri();
    await tauri.transport(request, new AbortController().signal);
    await tauri.transport(request, new AbortController().signal);
    const [first, second] = tauri.commands("secure_send").map((call) => call.args.requestId);
    expect(first).not.toBe(second);
  });

  it("S3-T3: secure_send の戻り値の status と headers がポートの応答になる", async () => {
    const tauri = fakeTauri({
      respond: async () => ({ status: 429, headers: { "retry-after": "3", "request-id": "req_x" } }),
    });
    const response = await tauri.transport(request, new AbortController().signal);
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ "retry-after": "3", "request-id": "req_x" });
  });

  it("S3-T4: Channel の chunk は同じ順・同じバイト列の Uint8Array で読め、end で終わる", async () => {
    const tauri = fakeTauri();
    const response = await tauri.transport(request, new AbortController().signal);
    // 読み手より先に届いた出来事も落とさない。
    tauri.emit({ event: "chunk", data: [0xe4, 0xb8] });
    const reading = readAll(response.body);
    tauri.emit({ event: "chunk", data: [0x8a] });
    tauri.emit({ event: "end" });
    const chunks = await reading;
    expect(chunks).toEqual([new Uint8Array([0xe4, 0xb8]), new Uint8Array([0x8a])]);
    expect(chunks.every((chunk) => chunk instanceof Uint8Array)).toBe(true);
    expect(tauri.commands("secure_cancel")).toEqual([]);
  });

  it("S3-T5: 読み出しの途中で中止すると、同じ requestId で secure_cancel を呼び、cancelled で失敗する", async () => {
    const tauri = fakeTauri();
    const controller = new AbortController();
    const response = await tauri.transport(request, controller.signal);
    const iterator = response.body[Symbol.asyncIterator]();
    tauri.emit({ event: "chunk", data: [1] });
    await iterator.next();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "SecureTransportError", kind: "cancelled" });
    const requestId = tauri.commands("secure_send")[0]!.args.requestId;
    expect(tauri.commands("secure_cancel").map((call) => call.args)).toContainEqual({ requestId });
  });

  it("S3-T6: secure_send の戻りを待つ間に中止すると、戻った後に同じ requestId で secure_cancel を呼び、cancelled で失敗する", async () => {
    const head = deferred<unknown>();
    const tauri = fakeTauri({ respond: () => head.promise });
    const controller = new AbortController();
    const sending = tauri.transport(request, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const cancelsBeforeReturn = tauri.commands("secure_cancel").length;
    head.resolve({ status: 200, headers: {} });

    await expect(sending).rejects.toMatchObject({ name: "SecureTransportError", kind: "cancelled" });
    const requestId = tauri.commands("secure_send")[0]!.args.requestId;
    const cancels = tauri.commands("secure_cancel");
    expect(cancels.length).toBeGreaterThan(cancelsBeforeReturn);
    expect(cancels.at(-1)!.args).toEqual({ requestId });
  });

  it("S3-T7: 中止済みの signal を渡すと invoke を呼ばずに cancelled で失敗する", async () => {
    const tauri = fakeTauri();
    const controller = new AbortController();
    controller.abort();
    await expect(tauri.transport(request, controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(tauri.calls).toEqual([]);
  });

  const kinds: SecureTransportErrorKind[] = [
    "unknown-destination",
    "key-not-registered",
    "key-store-failure",
    "invalid-header",
    "duplicate-request-id",
    "connection",
    "cancelled",
    "redirect-refused",
  ];
  it.each(kinds)("S3-T8: secure_send が種類 %s で失敗すると、同じ種類の SecureTransportError で失敗する", async (kind) => {
    const tauri = fakeTauri({ respond: () => Promise.reject({ kind }) });
    const failure = await tauri.transport(request, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SecureTransportError);
    expect((failure as SecureTransportError).kind).toBe(kind);
  });

  it("S3-T9: redirect-refused の status 307 は SecureTransportError の status になる", async () => {
    const tauri = fakeTauri({ respond: () => Promise.reject({ kind: "redirect-refused", status: 307 }) });
    await expect(tauri.transport(request, new AbortController().signal)).rejects.toMatchObject({
      kind: "redirect-refused",
      status: 307,
    });
  });

  it("想定外の失敗の値（ACL の拒否の文字列など）は connection として扱い、値の文字列を文言に含めない（仮定 A22）", async () => {
    const tauri = fakeTauri({ respond: () => Promise.reject("secure_send not allowed sk-ant-leak") });
    const failure = (await tauri.transport(request, new AbortController().signal).catch((e: unknown) => e)) as Error;
    expect(failure).toMatchObject({ kind: "connection" });
    expect(failure.message).not.toContain("sk-ant-leak");
  });

  it("S3-T10: Channel に connection の error が届くと、本文の読み出しは connection で失敗する", async () => {
    const tauri = fakeTauri();
    const response = await tauri.transport(request, new AbortController().signal);
    tauri.emit({ event: "chunk", data: [1] });
    tauri.emit({ event: "error", error: { kind: "connection" } });
    await expect(readAll(response.body)).rejects.toMatchObject({ name: "SecureTransportError", kind: "connection" });
  });

  it("S3-T11: 最後まで読まずに読み出しをやめると、同じ requestId で secure_cancel を呼ぶ", async () => {
    const tauri = fakeTauri();
    const response = await tauri.transport(request, new AbortController().signal);
    tauri.emit({ event: "chunk", data: [1] });
    tauri.emit({ event: "chunk", data: [2] });
    for await (const chunk of response.body) {
      expect(chunk).toEqual(new Uint8Array([1]));
      break;
    }
    const requestId = tauri.commands("secure_send")[0]!.args.requestId;
    expect(tauri.commands("secure_cancel").map((call) => call.args)).toEqual([{ requestId }]);
  });
});
