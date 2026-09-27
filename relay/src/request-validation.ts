/**
 * 要求の JSON の検査（機能仕様 docs/features/llm-relay-server.md
 * クリティカル設計決定 1、#635 のオーナーの決定 1）。
 *
 * 検査は**許可リスト方式**で、中継が知らない形は転送しない。枠の外で課金を
 * 増やしうる経路を塞ぐのが目的である:
 * - 最上位の項目は 9 つに限る（`mcp_servers`・`container`・`service_tier`・
 *   `speed`・`inference_geo`・`context_management` 等は転送しない）
 * - `tools` はアプリが定義する関数ツールに限る（プロバイダ側で実行される
 *   ツールは追加課金になる）
 * - **外部の内容を取り込むブロックを入力量の見積もりの前に拒否する**
 *   （#635 のオーナーの決定 1）。本文の JSON が小さくても、プロバイダが
 *   参照先や圧縮されたメディアを展開してトークン化すると、本文のバイト数から
 *   求めた予約額（仮定 A10）が実際の入力の原価を大きく下回るため。
 *   内容のブロックの `type` を許可リストで検査し、入れ子（`tool_result` の
 *   `content`）も同じ規則で再帰的に検査する。許可するのは本文にそのまま
 *   書かれた文字列だけを入力にするブロック（`text`・`tool_use`・
 *   `tool_result`・`thinking`・`redacted_thinking`）で、`image`・`document`・
 *   `search_result`・`container_upload`・サーバーツールの結果等は、`source`
 *   が URL・ファイル参照でも本文に埋め込まれた base64 でも拒否する（base64 の
 *   画像・PDF はバイト数に比べてトークン数が大きくなりうる〔PDF はページごとに
 *   画像としても課金され、可逆圧縮の画像は小さなバイト数で最大の画素数に
 *   なる〕ため、バイト数の見積もりで上限を守れない。アプリはこれらを送らない）
 * - `cache_control` の `ttl` は `5m`（既定）に限る。1 時間のキャッシュの書き込みは
 *   設定の `cacheWrite` の重み（5 分のキャッシュの単価）を超える単価で課金される
 *   ため、枠の計測が実際の原価を下回る
 */

/** プラン込みの既定のモデルを表す `model` の値（仮定 A2。S2 のアプリ側と同じ定数を使う）。 */
export const PLAN_DEFAULT_MODEL = "ai-boss-plan-default";

/** 最上位の項目の許可リスト（クリティカル設計決定 1）。 */
export const ALLOWED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "stream",
]);

/**
 * `messages[].content` の配列に置いてよい内容のブロックの `type`。いずれも
 * 入力になる内容が本文の JSON にそのまま書かれている（外部の内容を
 * 取り込まない）。
 */
const ALLOWED_MESSAGE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
]);

/** `tool_result.content` の配列・`system` の配列に置いてよい内容のブロックの `type`。 */
const ALLOWED_NESTED_BLOCK_TYPES: ReadonlySet<string> = new Set(["text"]);

export type ValidationFailureReason =
  | "not-an-object"
  | "unknown-top-level-field"
  | "model-not-plan-default"
  | "invalid-max-tokens"
  | "max-tokens-over-cap"
  | "invalid-stream"
  | "invalid-messages"
  | "invalid-system"
  | "disallowed-content-block"
  | "invalid-tools"
  | "server-tool"
  | "invalid-cache-control"
  | "invalid-object-field";

/** 検査を通った要求（最上位の 9 項目だけを持つ JSON のオブジェクト）。 */
export type MessagesRequest = Record<string, unknown> & { max_tokens: number };

export type ValidationResult =
  | { ok: true; request: MessagesRequest }
  | { ok: false; reason: ValidationFailureReason };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedCacheControl(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value) || value.type !== "ephemeral") {
    return false;
  }
  return Object.keys(value).every((key) => key === "type" || (key === "ttl" && value.ttl === "5m"));
}

/**
 * 内容のブロックを検査する。`allowedTypes` に無い `type` は拒否し、
 * `tool_result` の `content` は入れ子のブロックとして同じ規則（文字列か
 * `text` のブロックの配列）で検査する。
 */
function checkContentBlock(
  block: unknown,
  allowedTypes: ReadonlySet<string>,
): ValidationFailureReason | null {
  if (!isPlainObject(block) || typeof block.type !== "string" || !allowedTypes.has(block.type)) {
    return "disallowed-content-block";
  }
  if (!isAllowedCacheControl(block.cache_control)) {
    return "invalid-cache-control";
  }
  if (block.type === "tool_result") {
    return checkStringOrBlocks(block.content, ALLOWED_NESTED_BLOCK_TYPES, true);
  }
  return null;
}

function checkStringOrBlocks(
  content: unknown,
  allowedTypes: ReadonlySet<string>,
  optional: boolean,
): ValidationFailureReason | null {
  if (content === undefined && optional) {
    return null;
  }
  if (typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "disallowed-content-block";
  }
  for (const block of content) {
    const failure = checkContentBlock(block, allowedTypes);
    if (failure) {
      return failure;
    }
  }
  return null;
}

function checkMessages(messages: unknown): ValidationFailureReason | null {
  if (!Array.isArray(messages)) {
    return "invalid-messages";
  }
  for (const message of messages) {
    if (!isPlainObject(message)) {
      return "invalid-messages";
    }
    const failure = checkStringOrBlocks(message.content, ALLOWED_MESSAGE_BLOCK_TYPES, false);
    if (failure) {
      return failure;
    }
  }
  return null;
}

function checkSystem(system: unknown): ValidationFailureReason | null {
  if (system === undefined || typeof system === "string") {
    return null;
  }
  if (!Array.isArray(system)) {
    return "invalid-system";
  }
  for (const block of system) {
    const failure = checkContentBlock(block, ALLOWED_NESTED_BLOCK_TYPES);
    if (failure) {
      return failure;
    }
  }
  return null;
}

function checkTools(tools: unknown): ValidationFailureReason | null {
  if (tools === undefined) {
    return null;
  }
  if (!Array.isArray(tools)) {
    return "invalid-tools";
  }
  for (const tool of tools) {
    if (!isPlainObject(tool)) {
      return "invalid-tools";
    }
    // `type` が無いか `"custom"` の関数ツールだけ（プロバイダ側で実行される
    // ツールは追加課金になり、外部の内容も取り込む）。
    if (tool.type !== undefined && tool.type !== "custom") {
      return "server-tool";
    }
    if (!isAllowedCacheControl(tool.cache_control)) {
      return "invalid-cache-control";
    }
  }
  return null;
}

/**
 * 解釈済みの本文を検査する。`maxTokensCap` は設定の上限。拒否の理由は
 * 固定の語彙で返す（要求の中身を含めない）。
 */
export function validateMessagesRequest(body: unknown, maxTokensCap: number): ValidationResult {
  if (!isPlainObject(body)) {
    return { ok: false, reason: "not-an-object" };
  }
  // `JSON.parse` は `"__proto__"` も自分の項目として作るため、`Object.keys` で漏れなく数えられる。
  if (Object.keys(body).some((key) => !ALLOWED_TOP_LEVEL_FIELDS.has(key))) {
    return { ok: false, reason: "unknown-top-level-field" };
  }
  if (body.model !== PLAN_DEFAULT_MODEL) {
    return { ok: false, reason: "model-not-plan-default" };
  }
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return { ok: false, reason: "invalid-max-tokens" };
  }
  if (maxTokens > maxTokensCap) {
    return { ok: false, reason: "max-tokens-over-cap" };
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return { ok: false, reason: "invalid-stream" };
  }
  for (const name of ["thinking", "output_config", "tool_choice"] as const) {
    if (body[name] !== undefined && !isPlainObject(body[name])) {
      return { ok: false, reason: "invalid-object-field" };
    }
  }
  const failure = checkMessages(body.messages) ?? checkSystem(body.system) ?? checkTools(body.tools);
  if (failure) {
    return { ok: false, reason: failure };
  }
  return { ok: true, request: body as MessagesRequest };
}
