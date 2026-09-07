import { SESSION_TYPES } from "./session.js";
import type { NewSessionRecord } from "./sessions-repository.js";

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidType(value: unknown): value is (typeof SESSION_TYPES)[number] {
  return (
    typeof value === "string" &&
    SESSION_TYPES.includes(value as (typeof SESSION_TYPES)[number])
  );
}

const TYPE_ERROR = `type must be one of: ${SESSION_TYPES.join(", ")}`;

/**
 * Validates and normalizes a `POST /api/sessions` request body into a
 * `NewSessionRecord` ready for persistence.
 */
export function validateCreateSessionInput(
  body: unknown,
): ValidationResult<NewSessionRecord> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (!isValidType(body.type)) {
    return { valid: false, error: TYPE_ERROR };
  }

  return { valid: true, data: { type: body.type } };
}

export interface ChatMessageInput {
  content: string;
  /**
   * 未指定なら通常送信。指定するとやりなおし（この id 以降を切り捨てる）
   * （Issue #376, docs/features/chat-message-rewrite.md「IF / API」）。
   */
  replaceFromMessageId?: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Upper bound on a single chat message. Every message is stored and sent to
 * the Claude API as conversation history, so an unbounded payload would leak
 * straight into token cost; 10k characters is far beyond any realistic
 * consultation text.
 */
export const MAX_CHAT_MESSAGE_CONTENT_LENGTH = 10_000;

/**
 * Validates and normalizes a `POST /api/sessions/:id/messages` request body.
 */
export function validateChatMessageInput(
  body: unknown,
): ValidationResult<ChatMessageInput> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return { valid: false, error: "content is required and must not be empty" };
  }

  if (body.content.length > MAX_CHAT_MESSAGE_CONTENT_LENGTH) {
    return {
      valid: false,
      error: `content must be at most ${MAX_CHAT_MESSAGE_CONTENT_LENGTH} characters`,
    };
  }

  // 未指定ならここで確定する（早期 return）: `replaceFromMessageId` キーを
  // 一切持たない従来どおりの形を保つ（型アサーションに頼らず、`data` の
  // 実際の形も変えない — レビュー指摘: 以前は常にキーを持たせ `toEqual` の
  // undefined-as-absent 挙動で非回帰テストを通していたが、それはテストの
  // 緩さに実装を合わせる向きが逆だった）。
  if (body.replaceFromMessageId === undefined) {
    return { valid: true, data: { content: body.content } };
  }

  if (!isPositiveInteger(body.replaceFromMessageId)) {
    return {
      valid: false,
      error: "replaceFromMessageId must be a positive integer",
    };
  }

  // `isPositiveInteger` は型ガードなので、ここでは `body.replaceFromMessageId`
  // が `number` に絞り込み済みでキャストは不要。
  return {
    valid: true,
    data: { content: body.content, replaceFromMessageId: body.replaceFromMessageId },
  };
}
