import { TASK_PRIORITIES, TASK_STATUSES } from "./task.js";
import type { NewTaskRecord, TaskPatch } from "./tasks-repository.js";

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidStatus(value: unknown): value is (typeof TASK_STATUSES)[number] {
  return (
    typeof value === "string" &&
    TASK_STATUSES.includes(value as (typeof TASK_STATUSES)[number])
  );
}

function isValidPriority(
  value: unknown,
): value is (typeof TASK_PRIORITIES)[number] {
  return (
    typeof value === "string" &&
    TASK_PRIORITIES.includes(value as (typeof TASK_PRIORITIES)[number])
  );
}

const STATUS_ERROR = `status must be one of: ${TASK_STATUSES.join(", ")}`;
const PRIORITY_ERROR = `priority must be one of: ${TASK_PRIORITIES.join(", ")}, or null`;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// estimated_minutes は将来のサボり検知閾値（Issue #7）の基準になるため、
// 非負整数以外を保存させない
function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function validateOptionalFieldTypes(
  body: Record<string, unknown>,
): string | null {
  for (const field of ["description", "due_at", "boss_comment"] as const) {
    if (field in body && !isNullableString(body[field])) {
      return `${field} must be a string or null`;
    }
  }
  if ("category" in body && typeof body.category !== "string") {
    return "category must be a string";
  }
  if (
    "estimated_minutes" in body &&
    !isNullableNonNegativeInteger(body.estimated_minutes)
  ) {
    return "estimated_minutes must be a non-negative integer or null";
  }
  return null;
}

/**
 * Validates and normalizes a `POST /api/tasks` request body into a
 * `NewTaskRecord` ready for persistence. Returns a descriptive error message
 * on the first validation failure encountered.
 */
export function validateCreateTaskInput(
  body: unknown,
): ValidationResult<NewTaskRecord> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (typeof body.title !== "string" || body.title.trim() === "") {
    return { valid: false, error: "title is required and must not be empty" };
  }

  const status = body.status ?? "todo";
  if (!isValidStatus(status)) {
    return { valid: false, error: STATUS_ERROR };
  }

  const priority = body.priority ?? null;
  if (priority !== null && !isValidPriority(priority)) {
    return { valid: false, error: PRIORITY_ERROR };
  }

  const typeError = validateOptionalFieldTypes(body);
  if (typeError) {
    return { valid: false, error: typeError };
  }

  return {
    valid: true,
    data: {
      title: body.title,
      description: (body.description as string | null | undefined) ?? null,
      category: (body.category as string | undefined) ?? "work",
      priority,
      due_at: (body.due_at as string | null | undefined) ?? null,
      status,
      boss_comment: (body.boss_comment as string | null | undefined) ?? null,
      estimated_minutes:
        (body.estimated_minutes as number | null | undefined) ?? null,
    },
  };
}

const PATCHABLE_FIELDS = [
  "title",
  "description",
  "priority",
  "due_at",
  "status",
  "boss_comment",
  "estimated_minutes",
] as const;

/**
 * Validates and normalizes a `PATCH /api/tasks/:id` request body into a
 * `TaskPatch`. Only recognized fields present in the body are copied
 * through; absent fields are left untouched by the caller.
 */
export function validatePatchTaskInput(
  body: unknown,
): ValidationResult<TaskPatch> {
  if (!isRecord(body)) {
    return { valid: false, error: "request body must be a JSON object" };
  }

  if (
    "title" in body &&
    (typeof body.title !== "string" || body.title.trim() === "")
  ) {
    return { valid: false, error: "title must not be empty" };
  }

  if ("status" in body && !isValidStatus(body.status)) {
    return { valid: false, error: STATUS_ERROR };
  }

  if (
    "priority" in body &&
    body.priority !== null &&
    !isValidPriority(body.priority)
  ) {
    return { valid: false, error: PRIORITY_ERROR };
  }

  const typeError = validateOptionalFieldTypes(body);
  if (typeError) {
    return { valid: false, error: typeError };
  }

  const patch: TaskPatch = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in body) {
      (patch as Record<string, unknown>)[field] = body[field];
    }
  }

  return { valid: true, data: patch };
}
