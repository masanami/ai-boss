/**
 * 中継自身が返すエラーの応答（機能仕様 クリティカル設計決定 1・4・5）。
 *
 * 本文は Anthropic の形（`{"type":"error","error":{"type":"…","message":"…"}}`）で、
 * `message` は種類ごとの**固定の文言**にする。要求の中身（項目名を含む）を
 * 埋め込まない——項目名も利用者が送った文字列であり、推論内容を運びうるため。
 */

export type RelayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "request_too_large"
  | "usage_limit_exceeded"
  | "rate_limit_error"
  | "api_error";

const FIXED_MESSAGES: Record<RelayErrorType, string> = {
  invalid_request_error: "The request was rejected by the relay's request validation.",
  authentication_error: "The relay could not authenticate the request.",
  request_too_large: "The request body exceeds the relay's size limit.",
  usage_limit_exceeded: "The account has reached its usage limit.",
  rate_limit_error: "The account has too many requests in progress.",
  api_error: "The relay could not complete the request.",
};

export function relayErrorResponse(
  status: number,
  type: RelayErrorType,
  options: { limit?: "daily" | "monthly"; retryAfterSeconds?: number } = {},
): Response {
  const error: Record<string, string> = { type };
  if (options.limit !== undefined) {
    error.limit = options.limit;
  }
  error.message = FIXED_MESSAGES[type];
  const headers = new Headers({ "content-type": "application/json" });
  if (options.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(options.retryAfterSeconds));
  }
  return new Response(JSON.stringify({ type: "error", error }), { status, headers });
}
