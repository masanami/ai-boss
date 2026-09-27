/**
 * 中継が注入で受けるポート（認証・上流・ログ）の型と、実行基盤に依存しない
 * 実装（機能仕様 クリティカル設計決定 2・5・6、仮定 A12）。
 */

/**
 * 認証のポート: トークン → アカウント ID、拒否なら `null`（クリティカル
 * 設計決定 5）。本実装は #584 で決め、S4 で結合する。
 */
export type Authenticate = (token: string) => Promise<string | null>;

/** 認証のポートのテスト用の実装（トークンとアカウント ID の固定の対応表）。 */
export function createStaticTokenAuthenticator(accountIdsByToken: ReadonlyMap<string, string>): Authenticate {
  return async (token) => accountIdsByToken.get(token) ?? null;
}

/**
 * 上流への送信の失敗（仮定 A12）。`before-send` は要求のバイトを 1 つも
 * 送っていないことが確定している失敗（名前解決・接続の確立・TLS の確立の
 * 失敗）に限る。それ以外は `after-send`。区分の無い例外は中継が
 * `after-send` として扱う（安全側）。
 */
export class UpstreamFailure extends Error {
  readonly phase: "before-send" | "after-send";

  constructor(phase: "before-send" | "after-send") {
    super(`upstream request failed (${phase})`);
    this.name = "UpstreamFailure";
    this.phase = phase;
  }
}

/** 上流のポート。`signal` はアプリの中止を上流へ伝える。 */
export type UpstreamFetch = (request: Request, signal: AbortSignal) => Promise<Response>;

/**
 * Web 標準の `fetch` から上流のポートを作る。**リダイレクトに従わない**
 * （`redirect: "error"`）: 従うと、`fetch` はオリジンをまたいでも独自の
 * ヘッダ（`x-api-key`）を付けたまま転送先へ送るため、事業者のキーが上流の
 * URL 以外へ漏れうる。例外の区分（`before-send` の判定）は実行基盤の
 * `fetch` に合わせて S3 で作る（それまでは区分の無い例外＝`after-send`）。
 */
export function createFetchUpstream(fetchImpl: typeof fetch): UpstreamFetch {
  return (request, signal) => fetchImpl(request, { signal, redirect: "error" });
}

/**
 * ログのポートが受ける記録。**渡してよい項目はここに挙げたものだけ**
 * （アカウント ID・ステータス・モデル ID・トークン数・原価単位・所要時間・
 * エラーの種類。クリティカル設計決定 6）。推論内容・トークン・事業者の
 * キーを入れる項目は無い。
 */
export interface RelayLogRecord {
  event: "rejected" | "completed" | "settle_failed" | "internal_error";
  accountId?: string;
  status?: number;
  model?: string;
  errorType?: string;
  /** 精算の結果の種類（`actual`・`reserved`・`release`）。 */
  settlement?: "actual" | "reserved" | "release";
  units?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  durationMs?: number;
}

export interface RelayLogger {
  log(record: RelayLogRecord): void;
}
