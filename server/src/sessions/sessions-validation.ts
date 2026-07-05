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
}

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

  return { valid: true, data: { content: body.content } };
}
