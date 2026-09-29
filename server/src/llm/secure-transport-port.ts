/**
 * 転送のポート（機能仕様 docs/features/secure-transport-byok.md クリティカル
 * 設計決定 6・「IF / API（S2 で固定する TS 側の境界）」）。
 *
 * Rust の通信層（S1・`native/secure-transport/`）を TS 側から呼ぶための
 * 関数型の境界。TS のクライアント（`backends/byok-anthropic-backend.ts`）は
 * この型だけに依存し、Tauri の `invoke`・`Channel`・`requestId` の発行・
 * `secure_cancel` の呼び出し（S3 の責務）を直接扱わない——製品版のエントリ
 * （S3）が Tauri 実装のこのポートを注入する。
 *
 * このモジュールは Node 組み込み・`@anthropic-ai/sdk` 等を一切 import
 * しない（製品版のコアのバンドル検査
 * `server/src/core-entry.bundle.test.ts` の対象に含まれるため）。
 */

/** Rust 側が公開する宛先の名前（S1「IF / API」）。S2 では Anthropic の
 * Messages API 宛の 1 つだけを使う。将来 #582（OpenAI）・#583（中継サーバー）
 * が名前を増やす可能性があるため、ここでは（`"anthropic-messages"` に限定
 * する）リテラル型ではなく `string` として持つ——転送のポート自体は宛先の
 * 名前の集合を知らない（Rust 側の宛先の表がその集合を持つ）。 */
export type SecureTransportDestination = string;

export const ANTHROPIC_MESSAGES_DESTINATION: SecureTransportDestination = "anthropic-messages";

/** ポートへ渡す送信の要求（`requestId` の発行・秘密のヘッダの付与は Rust /
 * S3 実装の責務。呼び出し元〔TS のクライアント〕は秘密でないヘッダ
 * （例: `anthropic-beta`）だけを渡せる）。 */
export interface SecureTransportSendRequest {
  destination: SecureTransportDestination;
  headers?: Record<string, string>;
  /** JSON 文字列。バイト列への変換はポートの実装（S3）が行う。 */
  body: string;
}

/** 応答の頭。許可されたヘッダのみを持つ（Rust 側が固定する許可リスト）。 */
export interface SecureTransportResponseHeaders {
  "retry-after"?: string;
  "request-id"?: string;
  "content-type"?: string;
}

export interface SecureTransportResponse {
  status: number;
  headers: SecureTransportResponseHeaders;
  /** 本文のバイト列の断片の非同期の列（終端・エラーを含む）。最後まで読まない
   * 呼び出し元は、読み始めていなくても {@link discardSecureTransportBody} で
   * 捨てる（実装は送信の中止と未読の断片の解放をそこで行う）。 */
  body: AsyncIterable<Uint8Array>;
}

/**
 * 本文を読まずに（または途中で）捨てる。本文の反復子の `return` を呼び、
 * ポートの実装（S3 の Tauri 実装）に送信の中止と未読の断片の解放をさせる
 * （`for await` の `break` と同じ口）。捨てる側の失敗の報告を妨げないよう、
 * `return` の失敗は無視する。
 */
export async function discardSecureTransportBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await body[Symbol.asyncIterator]().return?.();
  } catch {
    // 捨てるだけなので、後始末の失敗は呼び出し元の失敗より優先しない。
  }
}

/**
 * 失敗の種類（機能仕様「IF / API（S2）」）。S1 の Rust 実装が持つ 8 種類の
 * うち、TS 側から観測しうる集合をそのまま持つ（「その他」は無い——未知の
 * 種類が来た場合も `"connection"` 等へ丸めず、S1 が実際に返す集合の外は
 * 呼び出し元の責務としない。仮定 A2）。
 */
export type SecureTransportErrorKind =
  | "unknown-destination"
  | "key-not-registered"
  | "key-store-failure"
  | "invalid-header"
  | "duplicate-request-id"
  | "connection"
  | "cancelled"
  | "redirect-refused";

export interface SecureTransportErrorOptions {
  /** `"redirect-refused"` のときのみ、模擬/実サーバーが返した 3xx のステータス。 */
  status?: number;
  cause?: unknown;
}

/**
 * 転送のポートが投げる失敗の値。**キー・要求本文・応答本文を含めない**
 * （機能仕様「失敗の種類」）——`message` は種類ごとの固定文言のみで組み立てる。
 */
export class SecureTransportError extends Error {
  readonly kind: SecureTransportErrorKind;
  readonly status?: number;

  constructor(kind: SecureTransportErrorKind, options: SecureTransportErrorOptions = {}) {
    super(SecureTransportError.describe(kind, options.status));
    this.name = "SecureTransportError";
    this.kind = kind;
    this.status = options.status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  private static describe(kind: SecureTransportErrorKind, status?: number): string {
    switch (kind) {
      case "unknown-destination":
        return "secure transport: unknown destination";
      case "key-not-registered":
        return "secure transport: key not registered";
      case "key-store-failure":
        return "secure transport: key store failure";
      case "invalid-header":
        return "secure transport: invalid header";
      case "duplicate-request-id":
        return "secure transport: duplicate request id";
      case "connection":
        return "secure transport: connection failure";
      case "cancelled":
        return "secure transport: cancelled";
      case "redirect-refused":
        return `secure transport: redirect refused (status ${status ?? "unknown"})`;
    }
  }
}

/**
 * 転送のポート本体。`signal` が中止されたら、実装（S3 の Tauri 実装）は
 * 送信中の要求を中止する（`secure_cancel` 相当）。TS のクライアントは
 * `signal` を中止するだけで、`requestId` の管理はポートの実装内に閉じる。
 */
export type SecureTransportPort = (
  request: SecureTransportSendRequest,
  signal: AbortSignal,
) => Promise<SecureTransportResponse>;
