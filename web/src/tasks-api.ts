import type { NewTaskInput, Task, TaskPatchInput } from "./task";
import type { TaskEvidence } from "./task-evidence";

const TASKS_URL = "/api/tasks";

/**
 * Thrown by the task API client functions (including the evidence
 * sub-resource endpoints) on a non-ok response. Mirrors
 * `daily-reports-api.ts`'s `ReportApiError`（機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 2-g: web の API 層は
 * エラーの `code` を保持し、UI は文言でなく `code` で分岐する。新しい体系は
 * 作らない）. `code` is `undefined` when the server didn't provide one (e.g.
 * an unexpected 500).
 */
export class TasksApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "TasksApiError";
    this.code = code;
  }
}

async function toTasksApiError(response: Response): Promise<TasksApiError> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return new TasksApiError(
      body.error ?? `request failed with status ${response.status}`,
      body.code,
    );
  } catch {
    return new TasksApiError(
      `request failed with status ${response.status}`,
      undefined,
    );
  }
}

/**
 * 完了報告のエビデンス不足（`code: "evidence_required"`、機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 2）を表示する固定文言。
 * サーバのメッセージ文言をそのまま出すのではなくこの定数を使うことで、
 * サーバ側の文言が変わっても表示が変わらない＝分岐が本当に `code` に基づく
 * ことを保証する（AC-76: 「文言だけを変えたエラーでも同じ分岐になる」）。
 */
export const EVIDENCE_REQUIRED_DISPLAY_MESSAGE =
  "エビデンスが添付されていないため、完了にできません";

/**
 * サーバの安定した `code` に対応する UI 所有の日本語文言（決定 2-g）。
 *
 * サーバ側のメッセージは開発者向けの英語（`task-evidences-routes.ts` の
 * "extension not allowed: …" 等）なので、そのまま日本語 UI に出さない。
 * ここに載っているのは `server/src/tasks/task-evidences-routes.ts` と
 * `server/src/tasks/tasks-routes.ts` が返す `code` の全件で、**分岐は文言では
 * なく `code` の値で行う**（AC-76: 文言だけを変えたエラーでも同じ分岐になる）。
 */
const ERROR_MESSAGE_BY_CODE: Record<string, string> = {
  evidence_required: EVIDENCE_REQUIRED_DISPLAY_MESSAGE,
  evidence_extension_not_allowed:
    "この形式のファイルは添付できません（画像・PDF・テキスト・Office 文書のみ）",
  evidence_file_too_large: "ファイルが大きすぎます（1 件あたり 10 MB まで）",
  evidence_limit_exceeded:
    "エビデンスは 1 つのタスクにつき 10 件までです。不要なものを削除してください",
  evidence_url_scheme_not_allowed:
    "http または https で始まる URL を指定してください",
  task_already_done:
    "完了したタスクのエビデンスは削除できません。ステータスを戻してから削除してください",
};

/**
 * `TasksApiError` を UI 表示用の文言に変換する。既知の `code` は
 * {@link ERROR_MESSAGE_BY_CODE} の日本語文言へ、未知の `code`・`code` 無しの
 * エラーはサーバのメッセージ（`TasksApiError` 以外の `Error` も含む）へ落とす。
 * 呼び出し元（`TaskBoard.tsx` の DnD・`use-checkin-panel.ts` の完了操作・
 * `use-task-evidences.ts` のエビデンス操作）で共有する。
 */
export function describeTasksApiError(error: unknown, fallback: string): string {
  if (error instanceof TasksApiError && error.code !== undefined) {
    const message = ERROR_MESSAGE_BY_CODE[error.code];
    if (message !== undefined) {
      return message;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * Fetches the full task list from the backend. Throws when the response is
 * not ok so callers can distinguish success from failure.
 */
export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(TASKS_URL);
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as Task[];
}

/**
 * Creates a new task from the given input. Throws with the server-provided
 * error message when validation fails (e.g. an empty title).
 */
export async function createTask(input: NewTaskInput): Promise<Task> {
  const response = await fetch(TASKS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as Task;
}

/**
 * Applies a partial update to the task with the given id and returns the
 * updated task. Throws with the server-provided error message on failure
 * (e.g. an unknown id or invalid field value). On the completion-evidence
 * gate（機能仕様 docs/features/completion-evidence-enforcement.md 決定 2）
 * this rejects with a `TasksApiError` whose `code` is `"evidence_required"`.
 */
export async function patchTask(
  id: number,
  patch: TaskPatchInput,
): Promise<Task> {
  const response = await fetch(`${TASKS_URL}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as Task;
}

/**
 * Builds the URL for a file evidence's body (`GET
 * /api/tasks/:id/evidences/:evidenceId/content`). Used as an `<a href>` so
 * opening it is a real navigation, not a fetch — the browser handles
 * inline display (image/PDF) vs. download itself（明示的な仮定 9: 独自
 * ビューアは作らない）.
 */
export function evidenceContentUrl(taskId: number, evidenceId: number): string {
  return `${TASKS_URL}/${taskId}/evidences/${evidenceId}/content`;
}

/** Fetches the evidence metadata list for a task (never includes file bodies). */
export async function fetchTaskEvidences(taskId: number): Promise<TaskEvidence[]> {
  const response = await fetch(`${TASKS_URL}/${taskId}/evidences`);
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as TaskEvidence[];
}

/**
 * Uploads a single file as evidence (`multipart/form-data`, field name
 * `file` — 1 リクエスト 1 件。複数同時アップロードは実装しない）.
 */
export async function addFileEvidence(
  taskId: number,
  file: File,
): Promise<TaskEvidence> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${TASKS_URL}/${taskId}/evidences`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as TaskEvidence;
}

/** Adds a link (URL) as evidence. */
export async function addLinkEvidence(
  taskId: number,
  url: string,
): Promise<TaskEvidence> {
  const response = await fetch(`${TASKS_URL}/${taskId}/evidences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
  return (await response.json()) as TaskEvidence;
}

/** Deletes an evidence by id. Throws `TasksApiError` with `code:
 * "task_already_done"` when the task is already `done` (決定5). */
export async function deleteTaskEvidence(
  taskId: number,
  evidenceId: number,
): Promise<void> {
  const response = await fetch(`${TASKS_URL}/${taskId}/evidences/${evidenceId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw await toTasksApiError(response);
  }
}
