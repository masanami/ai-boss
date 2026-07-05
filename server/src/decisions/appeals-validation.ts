export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface AppealInput {
  content: string;
}

/**
 * Validates a `POST /api/decisions/:id/appeals` request body: `content` is
 * the only field a user may supply (the boss's verdict/response is derived
 * from Claude, not the request).
 */
export function validateAppealInput(body: unknown): ValidationResult<AppealInput> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return {
      valid: false,
      error: "content is required and must be a non-empty string",
    };
  }

  return { valid: true, data: { content: body.content } };
}
