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
  /**
   * 随時メンタリングの明示的な要求（Issue #409, 親 #276, 機能仕様
   * docs/features/work-approach-mentoring.md「画面・API設計 / チャット」）。
   * `true` のとき、そのターンのシステムプロンプトへメンタリングの指示を積む
   * （強制設定に関わらず）。任意・boolean のみ・既定 false。
   *
   * `replaceFromMessageId` と同じ undefined-as-absent の作法を踏襲し、
   * `false` 相当（省略または明示的な `false`）のときは `data` にキー自体を
   * 持たせない — `true` のときだけ明示的にキーを持つ。
   */
  mentoring?: boolean;
  /**
   * このターンのメンタリングの対象タスクの id（Issue #471, 親 #444 決定7,
   * docs/features/task-scoped-mentoring.md「IF」）。`mentoring: true` と
   * 同時にのみ指定できる — 伴わない場合は無視せず 400 で拒否する。形の検証は
   * `replaceFromMessageId` と同じ `isPositiveInteger` を再利用する（0・負数・
   * 小数・文字列・真偽値はいずれも 400）。存在検証（DB を読む）はここでは
   * 行わない — ルート側（`chat-messages-route.ts`）の責務。
   *
   * `mentoring`/`replaceFromMessageId` と同じ undefined-as-absent の作法を
   * 踏襲し、値があるときだけ `data` にキーを持つ。
   */
  mentoringTaskId?: number;
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

  if (body.mentoring !== undefined && typeof body.mentoring !== "boolean") {
    return { valid: false, error: "mentoring must be a boolean" };
  }

  // Issue #471（決定7）: 形の検証（isPositiveInteger の再利用）と、
  // `mentoring: true` との組み合わせ検証。無視せず 400 で拒否する
  // （「対象タスクを指定したつもりで紐づかないメンタリングが残る」を防ぐ）。
  if (body.mentoringTaskId !== undefined) {
    if (!isPositiveInteger(body.mentoringTaskId)) {
      return {
        valid: false,
        error: "mentoringTaskId must be a positive integer",
      };
    }
    if (body.mentoring !== true) {
      return {
        valid: false,
        error: "mentoringTaskId requires mentoring: true",
      };
    }
  }

  // `mentoring` は `true` のときだけキーを持つ（`ChatMessageInput` の JSDoc
  // が定める undefined-as-absent の作法。既定 false は「キーが無い」で表す）。
  const mentoringField = body.mentoring === true ? { mentoring: true as const } : {};
  // `mentoringTaskId` も同じ作法（値があるときだけキーを持つ）。上のガードを
  // 通っていれば `isPositiveInteger` の型ガードにより number に絞り込み済み。
  const mentoringTaskIdField = isPositiveInteger(body.mentoringTaskId)
    ? { mentoringTaskId: body.mentoringTaskId }
    : {};

  // 未指定ならここで確定する（早期 return）: `replaceFromMessageId` キーを
  // 一切持たない従来どおりの形を保つ（型アサーションに頼らず、`data` の
  // 実際の形も変えない — レビュー指摘: 以前は常にキーを持たせ `toEqual` の
  // undefined-as-absent 挙動で非回帰テストを通していたが、それはテストの
  // 緩さに実装を合わせる向きが逆だった）。
  if (body.replaceFromMessageId === undefined) {
    return {
      valid: true,
      data: { content: body.content, ...mentoringField, ...mentoringTaskIdField },
    };
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
    data: {
      content: body.content,
      replaceFromMessageId: body.replaceFromMessageId,
      ...mentoringField,
      ...mentoringTaskIdField,
    },
  };
}
