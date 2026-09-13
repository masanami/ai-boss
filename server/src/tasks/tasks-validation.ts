import { TASK_PRIORITIES, TASK_STATUSES } from "./task.js";
import type { NewTaskRecord, TaskPatch } from "./tasks-repository.js";
import { normalizeDueAtToDateKey } from "./due-at.js";
import { isValidIsoDateTime } from "../lib/iso-date.js";

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; error: string; code?: "commitment_requires_todo" };

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

// evidence_required は HTTP 境界で常に boolean（機能仕様
// docs/features/completion-evidence-enforcement.md 明示的な仮定 8）。DB の
// INTEGER (0/1) への変換は tasks-repository.ts の1箇所に閉じており、ここでは
// 型を JSON boolean に固定するだけ（settings-validation.ts の
// validateBoolean と同じ規律）。
const EVIDENCE_REQUIRED_ERROR = "evidence_required must be a boolean";

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

// estimated_minutes は将来のサボり検知閾値（Issue #7）の基準になるため、
// 非負整数以外を保存させない
function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

const DUE_AT_FORMAT_ERROR =
  'due_at must be an ISO 8601 date ("YYYY-MM-DD") or date-time';

// 着手の約束（機能仕様 docs/features/task-start-commitment.md 決定2・#523）:
// 時刻とオフセット（`Z` または `±HH:MM`）を必須とする ISO 8601 日時のみ受理
// する。`lib/iso-date.ts` の `isValidIsoDateTime` はオフセットを省略しても
// 通すため、オフセット必須の検査をこのパターンで別に行い、暦の実在の検査は
// `isValidIsoDateTime` に委ねる（決定2「書式と暦の実在は別に検査する」）。
const COMMITTED_START_AT_OFFSET_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const COMMITTED_START_AT_FORMAT_ERROR =
  'committed_start_at must be an ISO 8601 date-time with an offset (e.g. "2026-09-14T20:00:00+09:00"), or null';

// 着手の約束は todo のタスクにだけ置ける（機能仕様
// docs/features/task-start-commitment.md 決定3-2・Issue #527）。作成時は
// `updateTask` のような既存行が無いため、この検証層で `status`（省略時
// "todo"）と `committed_start_at` の組だけで判定する。
// 更新時の拒否（tasks-routes.ts の PATCH・task-tools.ts の update_task）も
// この文言を使う（同じ拒否で経路ごとに error が食い違わないよう 1 箇所に置く）。
export const COMMITMENT_REQUIRES_TODO_ERROR =
  "着手の約束はステータスが todo のタスクにだけ設定できます";

function isValidCommittedStartAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    COMMITTED_START_AT_OFFSET_PATTERN.test(value) &&
    isValidIsoDateTime(value)
  );
}

/**
 * 受理した `committed_start_at` を保存形式（UTC ISO）へ正規化する
 * （決定2）。`value` は事前に `isValidCommittedStartAt` を通っているか、
 * 省略/`null`（＝約束なし）のいずれかであることを呼び出し側が保証する。
 */
function normalizeCommittedStartAt(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return new Date(value).toISOString();
}

function validateOptionalFieldTypes(
  body: Record<string, unknown>,
): string | null {
  for (const field of ["description", "due_at", "boss_comment"] as const) {
    if (field in body && !isNullableString(body[field])) {
      return `${field} must be a string or null`;
    }
  }
  // due_at は型が string でも、暦として解釈できない値は保存させない
  // （#199 / GAP-34・Codex 指摘 CODE-001）。
  // POST・PATCH の両経路がこの関数を通るため、ここ 1 箇所で両方を塞ぐ。
  //
  // 読み出し側（`tasks/due-at.ts`）も不正値を「締切なし」へ倒すようになった
  // が（ADR 0010 決定 6・#442）、それは既に DB にある値を吸収するための措置で
  // あり、入口の検査を省いてよい理由にはならない（2 形式の混在をこれ以上
  // 増やさないため、書き込み時に弾くほうを正とする）。
  //
  // 判定は `isValidIsoDateOrDateTime` ではなく **`normalizeDueAtToDateKey` が
  // 暦日を返せるか**で行う（PR #458 の Codex 指摘 P2）。前者は「暦として実在
  // するか」しか見ないため、`0099-12-31` のように**受理はされるが暦日ユーティ
  // リティ側が解釈できない**値が素通りし、201 を返しながら `due_at` は `null`
  // として保存されて**利用者の締切が黙って消えて**いた。
  //
  // 書き込みの可否を読み出しと同じ関数に委ねることで、「受理する値」と「解釈
  // できる値」が構造的に一致する（2 つの述語が将来ずれる余地を残さない）。
  if (
    "due_at" in body &&
    typeof body.due_at === "string" &&
    normalizeDueAtToDateKey(body.due_at) === null
  ) {
    return DUE_AT_FORMAT_ERROR;
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
  // 着手の約束（決定2）: null か、時刻とオフセットを含む ISO 8601 日時の
  // どちらでもない値は拒否する。POST・PATCH の両経路がこの関数を通る。
  if (
    "committed_start_at" in body &&
    body.committed_start_at !== null &&
    !isValidCommittedStartAt(body.committed_start_at)
  ) {
    return COMMITTED_START_AT_FORMAT_ERROR;
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

  const evidenceRequired = body.evidence_required ?? false;
  if (!isBoolean(evidenceRequired)) {
    return { valid: false, error: EVIDENCE_REQUIRED_ERROR };
  }

  const typeError = validateOptionalFieldTypes(body);
  if (typeError) {
    return { valid: false, error: typeError };
  }

  // 決定3-2（Issue #527）: status（省略時 todo）が todo でないのに
  // committed_start_at に非 null の値が来た作成要求は拒否する。形式の検証
  // （上の validateOptionalFieldTypes）の後に置く。
  const committedStartAtRaw =
    (body.committed_start_at as string | null | undefined) ?? null;
  if (committedStartAtRaw !== null && status !== "todo") {
    return {
      valid: false,
      error: COMMITMENT_REQUIRES_TODO_ERROR,
      code: "commitment_requires_todo",
    };
  }

  return {
    valid: true,
    data: {
      title: body.title,
      description: (body.description as string | null | undefined) ?? null,
      category: (body.category as string | undefined) ?? "work",
      priority,
      // 保存形式はローカル暦日に一本化する（ADR 0010 決定 1）。時刻付きの旧形式
      // は**拒否せず**受理して暦日へ落とす（決定 4。書き手がボス（LLM）であり
      // 説明文への追従は確率的で、拒否するとツール失敗が利用者の会話に出るため）。
      // 妥当性検査は上の validateOptionalFieldTypes が済ませているので、ここへ
      // 来る値は null か暦として解釈できる文字列のいずれか。
      due_at: normalizeDueAtToDateKey(
        (body.due_at as string | null | undefined) ?? null,
      ),
      status,
      boss_comment: (body.boss_comment as string | null | undefined) ?? null,
      estimated_minutes:
        (body.estimated_minutes as number | null | undefined) ?? null,
      evidence_required: evidenceRequired,
      // 着手の約束（決定1・2）。入力の committed_at は受け付けない（無視する
      // ことで拒否と同じ効果になる。NewTaskRecord に committed_at フィールド
      // 自体が存在しない）。
      committed_start_at: normalizeCommittedStartAt(
        (body.committed_start_at as string | null | undefined) ?? null,
      ),
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
  "evidence_required",
  "committed_start_at",
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

  // MVP では category は 'work' 固定（正本仕様）。無視して 200 を返すと
  // 呼び出し側が更新されたと誤認するため、明示的に拒否する
  if ("category" in body) {
    return {
      valid: false,
      error: "category cannot be updated (fixed to 'work' in MVP)",
    };
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

  if ("evidence_required" in body && !isBoolean(body.evidence_required)) {
    return { valid: false, error: EVIDENCE_REQUIRED_ERROR };
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
  // POST と同じく、PATCH でも暦日へ正規化してから保存する（ADR 0010 決定 4）。
  // ここで正規化しないと、web の日付編集は暦日を送るのにボス経由の更新だけが
  // 時刻付きのまま残り、2 形式が DB に混在し続ける。
  if ("due_at" in body) {
    patch.due_at = normalizeDueAtToDateKey(
      (body.due_at as string | null | undefined) ?? null,
    );
  }
  // 着手の約束（決定1・2）。`committed_at` は PATCHABLE_FIELDS に含めない
  // ため、入力の値は無視される（決定1）。
  if ("committed_start_at" in body) {
    patch.committed_start_at = normalizeCommittedStartAt(
      (body.committed_start_at as string | null | undefined) ?? null,
    );
  }

  return { valid: true, data: patch };
}
