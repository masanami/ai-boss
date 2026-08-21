import { CHECKIN_TYPES } from "./activity-event.js";
import type { CheckinType } from "./activity-event.js";

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

export interface CheckinInput {
  type: CheckinType;
  task_id: number | null;
  note: string | null;
  expected_minutes: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidCheckinType(value: unknown): value is CheckinType {
  return (
    typeof value === "string" &&
    CHECKIN_TYPES.includes(value as CheckinType)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const TYPE_ERROR = `type must be one of: ${CHECKIN_TYPES.join(", ")}`;

/**
 * Validates and normalizes a `POST /api/checkins` request body into a
 * `CheckinInput` ready for persistence via `recordActivityEvent`.
 * Task-existence checks (404) are the route handler's responsibility —
 * this function only validates the shape/type of the body (400 errors).
 */
export function validateCheckinInput(
  body: unknown,
): ValidationResult<CheckinInput> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (!isValidCheckinType(body.type)) {
    return { valid: false, error: TYPE_ERROR };
  }

  if (body.type === "task_start" || body.type === "task_pause") {
    if (typeof body.task_id !== "number") {
      return {
        valid: false,
        error: `task_id is required and must be a number for ${body.type}`,
      };
    }
  } else if (
    "task_id" in body &&
    body.task_id !== undefined &&
    body.task_id !== null &&
    typeof body.task_id !== "number"
  ) {
    return { valid: false, error: "task_id must be a number or null" };
  }

  if (
    "expected_minutes" in body &&
    body.expected_minutes !== undefined &&
    body.expected_minutes !== null &&
    !isPositiveInteger(body.expected_minutes)
  ) {
    return {
      valid: false,
      error: "expected_minutes must be a positive integer or null",
    };
  }

  if (
    "note" in body &&
    body.note !== undefined &&
    body.note !== null &&
    typeof body.note !== "string"
  ) {
    return { valid: false, error: "note must be a string or null" };
  }

  return {
    valid: true,
    data: {
      type: body.type,
      task_id: (body.task_id as number | null | undefined) ?? null,
      note: (body.note as string | null | undefined) ?? null,
      expected_minutes:
        (body.expected_minutes as number | null | undefined) ?? null,
    },
  };
}
