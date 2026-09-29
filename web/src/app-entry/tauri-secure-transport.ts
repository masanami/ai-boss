import {
  SecureTransportError,
  type SecureTransportErrorKind,
  type SecureTransportPort,
  type SecureTransportResponseHeaders,
} from "../../../server/src/core-entry.js";

/**
 * 転送のポートの Tauri 実装（#581 S3・機能仕様
 * docs/features/secure-transport-byok.md クリティカル設計決定 2・8・
 * 「IF / API（S3）」）。
 *
 * - 送信は器のコマンド `secure_send` を呼び、応答の頭を受け取ったら返す。
 *   本文の断片・終わり・途中の失敗は同じ要求の `Channel` で届く
 * - `requestId` は要求ごとにここで発行する（TS のクライアントは知らない）
 * - `signal` が中止されたら `secure_cancel` を呼ぶ。Rust が要求を登録する前に
 *   中止が届いた場合に送信が続かないよう、`secure_send` が戻った時点で中止
 *   済みならもう一度 `secure_cancel` を呼び「中止」で失敗する（迂回経路 B6）。
 *   本文を最後まで読まずに読み出しをやめた場合・読み始めずに本文を捨てた場合
 *   （本文の反復子の `return`。`discardSecureTransportBody`）も `secure_cancel`
 *   を呼び、未読の断片を捨てる
 *
 * キーはこのモジュールを通らない（キーを付与するのは Rust）。
 */

export type TauriInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** 器の `Channel` で届く出来事（Rust の `StreamEvent`）。 */
export type SecureStreamEvent =
  | { event: "chunk"; data: number[] }
  | { event: "end" }
  | { event: "error"; error: unknown };

/** `@tauri-apps/api/core` の `Channel` のうち、ここで使う部分。 */
export interface SecureEventChannel {
  onmessage: (event: SecureStreamEvent) => void;
}

export interface TauriSecureTransportDeps {
  invoke: TauriInvoke;
  createChannel: () => SecureEventChannel;
  newRequestId: () => string;
}

const TRANSPORT_ERROR_KINDS: readonly SecureTransportErrorKind[] = [
  "unknown-destination",
  "key-not-registered",
  "key-store-failure",
  "invalid-header",
  "duplicate-request-id",
  "connection",
  "cancelled",
  "redirect-refused",
];

/**
 * 器の失敗の値（`{ kind, status? }`）を転送のポートの失敗へ写す。想定外の形
 * （ACL の拒否の文字列など）は「接続失敗」として扱う（仮定 A22）。値の中身
 * （文字列）は失敗の文言に含めない。
 */
export function toSecureTransportError(error: unknown): SecureTransportError {
  if (typeof error === "object" && error !== null) {
    const { kind, status } = error as { kind?: unknown; status?: unknown };
    const known = TRANSPORT_ERROR_KINDS.find((candidate) => candidate === kind);
    if (known) {
      return new SecureTransportError(known, typeof status === "number" ? { status } : {});
    }
  }
  return new SecureTransportError("connection");
}

const ABORTED = Symbol("aborted");

/**
 * `Channel` の出来事を順に受け取る列（届いた順・読み手が遅れても落とさない）。
 * 中止・`close` の後に届いた出来事は溜めない（読み手がもういないため）。
 */
function createEventQueue(signal: AbortSignal) {
  const items: SecureStreamEvent[] = [];
  let waiter: ((value: SecureStreamEvent | typeof ABORTED) => void) | undefined;
  let closed = false;
  const onAbort = (): void => {
    items.length = 0;
    const resolve = waiter;
    waiter = undefined;
    resolve?.(ABORTED);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    push(event: SecureStreamEvent): void {
      if (closed || signal.aborted) return;
      const resolve = waiter;
      if (resolve) {
        waiter = undefined;
        resolve(event);
      } else {
        items.push(event);
      }
    },
    next(): Promise<SecureStreamEvent | typeof ABORTED> {
      if (signal.aborted) return Promise.resolve(ABORTED);
      const item = items.shift();
      if (item) return Promise.resolve(item);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    /** 溜まった出来事を捨て、以後の出来事を受け取らない。 */
    close(): void {
      closed = true;
      items.length = 0;
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function toHeaders(value: unknown): SecureTransportResponseHeaders {
  const headers: SecureTransportResponseHeaders = {};
  if (typeof value !== "object" || value === null) return headers;
  for (const name of ["retry-after", "request-id", "content-type"] as const) {
    const header = (value as Record<string, unknown>)[name];
    if (typeof header === "string") headers[name] = header;
  }
  return headers;
}

export function createTauriSecureTransport(deps: TauriSecureTransportDeps): SecureTransportPort {
  return async (request, signal) => {
    if (signal.aborted) {
      throw new SecureTransportError("cancelled");
    }
    const requestId = deps.newRequestId();
    const cancel = (): void => {
      void deps.invoke("secure_cancel", { requestId }).catch(() => undefined);
    };
    const queue = createEventQueue(signal);
    const channel = deps.createChannel();
    channel.onmessage = (event) => queue.push(event);
    signal.addEventListener("abort", cancel, { once: true });

    let head: unknown;
    try {
      head = await deps.invoke("secure_send", {
        requestId,
        destination: request.destination,
        headers: request.headers ?? {},
        body: request.body,
        onEvent: channel,
      });
    } catch (error) {
      signal.removeEventListener("abort", cancel);
      throw signal.aborted ? new SecureTransportError("cancelled") : toSecureTransportError(error);
    }
    if (signal.aborted) {
      // Rust が要求を登録する前に届いた中止は効かないため、もう一度止める。
      signal.removeEventListener("abort", cancel);
      cancel();
      throw new SecureTransportError("cancelled");
    }

    // 本文は非同期ジェネレーターにしない: ジェネレーターは一度も `next` を
    // 呼ばれないまま `return` されると `finally` を走らせないため、本文を読まずに
    // 捨てる呼び出し元（2xx 以外の応答）で Rust の中継が止まらず、未読の断片が
    // 列に溜まり続ける。ここでは `return` が読み出しの開始の有無によらず後始末を
    // 行う反復子を自前で持つ（呼び出し元は `discardSecureTransportBody` で捨てる）。
    let settled = false;
    const settle = (finished: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      queue.close();
      // 中止・読み出しの打ち切りで終わったときは、Rust 側の送信も止める。
      if (!finished) cancel();
    };
    const done = (): IteratorReturnResult<undefined> => ({ done: true, value: undefined });
    const body: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return body;
      },
      async next() {
        if (settled) return done();
        const event = await queue.next();
        if (event === ABORTED) {
          settle(false);
          throw new SecureTransportError("cancelled");
        }
        if (event.event === "chunk") {
          return { done: false, value: Uint8Array.from(event.data) };
        }
        settle(true);
        if (event.event === "end") return done();
        throw toSecureTransportError(event.error);
      },
      async return() {
        settle(false);
        return done();
      },
    };

    const { status, headers } = (head ?? {}) as { status?: unknown; headers?: unknown };
    return {
      status: typeof status === "number" ? status : 0,
      headers: toHeaders(headers),
      body,
    };
  };
}
