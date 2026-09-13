import type Database from "better-sqlite3";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { resolveEvidenceSettings } from "../settings/evidence-settings.js";
import { countTaskEvidences } from "./task-evidences-repository.js";
import type { Task, TaskPriority, TaskStatus } from "./task.js";

/**
 * Raw shape of a `tasks` row as SQLite returns it: `evidence_required` is
 * stored as `INTEGER` (0/1, no boolean type in SQLite), unlike the `Task`
 * type where it is a `boolean` (機能仕様
 * docs/features/completion-evidence-enforcement.md 明示的な仮定 8: HTTP
 * 境界では一貫して boolean、DB では INTEGER。変換はこのモジュール1箇所に
 * 閉じる）。
 */
interface TaskRow extends Omit<Task, "evidence_required"> {
  evidence_required: number;
}

function mapTaskRow(row: TaskRow): Task {
  return { ...row, evidence_required: row.evidence_required === 1 };
}

/**
 * Returns all tasks ordered by creation time ascending. `id` is used as a
 * tie-breaker so ordering stays deterministic when `created_at` collides
 * (e.g. tasks created within the same second).
 */
export function listTasks(db: Database.Database): Task[] {
  const rows = db
    .prepare("SELECT * FROM tasks ORDER BY created_at ASC, id ASC")
    .all() as TaskRow[];
  return rows.map(mapTaskRow);
}

export interface NewTaskRecord {
  title: string;
  description: string | null;
  category: string;
  priority: TaskPriority | null;
  due_at: string | null;
  status: TaskStatus;
  boss_comment: string | null;
  estimated_minutes: number | null;
  /**
   * 省略時は `false`（`tasks.evidence_required` の `DEFAULT 0` と同じ既定）。
   * `validateCreateTaskInput` は常に明示的な値を渡すが、この repository を
   * 直接呼ぶ既存の呼び出し元・テストの大半はエビデンス機能と無関係なため、
   * ここを省略可能にして無用な波及を避ける（軽微・可逆な判断）。
   */
  evidence_required?: boolean;
  /**
   * 着手の約束の日時（機能仕様 docs/features/task-start-commitment.md
   * 決定1・2）。省略時は `null`（約束なし）と同じ扱い。省略可能にするのは
   * `evidence_required` と同じ理由（既存呼び出し元への波及を避けるため）。
   * `committed_at`（約束を置いた時刻）はここに含めない —
   * `insertTask` が `now` から内部で導出する（決定1: 入力として受け付けない）。
   */
  committed_start_at?: string | null;
}

export function findTaskById(
  db: Database.Database,
  id: number,
): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
  return row ? mapTaskRow(row) : undefined;
}

/**
 * Inserts a new task with server-managed timestamps and returns the
 * persisted row (all columns, as read back from the database).
 *
 * Does not itself enforce the evidence gate (決定 2-h) — `POST /api/tasks`
 * (the only real-code call site that can create a task directly `done`,
 * since `TaskForm` never sends `status` and the `create_task` boss tool's
 * schema has no `status` field either) checks {@link isEvidenceGateBlocking}
 * before calling this function.
 */
export function insertTask(
  db: Database.Database,
  record: NewTaskRecord,
): Task {
  const now = new Date().toISOString();
  const completedAt = record.status === "done" ? now : null;
  // 決定1: committed_start_at が非 null なら committed_at はこの insert の
  // now（created_at と同じ値）。入力として受け付けないため、常にここで導出
  // する。
  const committedStartAt = record.committed_start_at ?? null;
  const committedAt = committedStartAt !== null ? now : null;

  const result = db
    .prepare(
      `INSERT INTO tasks (
        title, description, category, priority, due_at, status,
        boss_comment, estimated_minutes, created_at, updated_at, completed_at,
        evidence_required, committed_start_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.title,
      record.description,
      record.category,
      record.priority,
      record.due_at,
      record.status,
      record.boss_comment,
      record.estimated_minutes,
      now,
      now,
      completedAt,
      record.evidence_required ? 1 : 0,
      committedStartAt,
      committedAt,
    );

  const task = findTaskById(db, Number(result.lastInsertRowid));
  if (!task) {
    throw new Error("failed to read back the inserted task");
  }
  return task;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  priority?: TaskPriority | null;
  due_at?: string | null;
  status?: TaskStatus;
  boss_comment?: string | null;
  estimated_minutes?: number | null;
  evidence_required?: boolean;
  /**
   * 着手の約束の日時（決定1・2）。`undefined`（キー自体を含めない）は
   * 「変更しない」、`null` は「取り消す」、文字列は「設定・変更する」を
   * 表す。`committed_at` はここに含めない（決定1: 入力として受け付けない。
   * `updateTask` が値が変わる更新のときだけ `now` から導出する）。
   */
  committed_start_at?: string | null;
}

/**
 * Shared predicate for the completion-evidence gate (機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 2 / 決定 2-h):
 * whether completing a task (existing or about-to-be-created) is blocked
 * because the evidence-enforcement setting is on, the task requires
 * evidence, and it has none yet.
 *
 * `taskId: null` represents the create path (`POST /api/tasks` creating a
 * task directly with `status: "done"`) — a task that doesn't exist yet can
 * never have evidence attached, so the count is treated as 0 without a
 * lookup. `taskId` a number represents the update path (`updateTask`),
 * where the task's actual attached-evidence count is read.
 *
 * Called from exactly two places (決定 2-h: "関門を2つに増やすのではなく、
 * 1つの述語を2箇所から呼ぶ"): `tasks-routes.ts`'s `POST /api/tasks` handler,
 * and `updateTask` below.
 */
export function isEvidenceGateBlocking(
  db: Database.Database,
  input: { taskId: number | null; evidenceRequired: boolean },
): boolean {
  if (!input.evidenceRequired) {
    return false;
  }
  const { enforcementEnabled } = resolveEvidenceSettings(db);
  if (!enforcementEnabled) {
    return false;
  }
  const evidenceCount =
    input.taskId === null ? 0 : countTaskEvidences(db, input.taskId);
  return evidenceCount === 0;
}

export type UpdateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "evidence_required" };

const EVIDENCE_REQUIRED_LABELS: Record<"true" | "false", string> = {
  true: "必須",
  false: "不要",
};

/**
 * Builds the `task_update` activity event's `note` for a `PATCH` that
 * changes `evidence_required` (決定 3-b: 上書きの痕跡を `note` に残す).
 * Returns `null` when the patch doesn't actually change the value — either
 * because it omits `evidence_required` entirely, or includes it unchanged
 * (明示的な仮定: "変更する" は値が変わる場合のみを指す。この2つ目のケース
 * は受入基準に無いが、"変更した" という文言に忠実な解釈として採った)。
 */
function buildEvidenceRequiredChangeNote(
  existing: boolean,
  patchValue: boolean | undefined,
): string | null {
  if (patchValue === undefined || patchValue === existing) {
    return null;
  }
  const before = EVIDENCE_REQUIRED_LABELS[existing ? "true" : "false"];
  const after = EVIDENCE_REQUIRED_LABELS[patchValue ? "true" : "false"];
  return `エビデンス要否を ${before} から ${after} に変更`;
}

/**
 * Builds the `task_update` activity event's `note` fragment for a `PATCH`
 * that changes `committed_start_at`（機能仕様
 * docs/features/task-start-commitment.md 決定3: 変更の前後を `note` に
 * 残す）。Returns `null` when the patch doesn't change the value — either
 * because it omits `committed_start_at` entirely, or includes it unchanged
 * (同じ「値が変わる場合のみ」の解釈を `buildEvidenceRequiredChangeNote` と
 * 揃える)。値は保存形の ISO 文字列そのまま、`null` は文字列 `"null"` にする
 * （決定3）。
 *
 * 退役（ステータス変更による約束の消去、決定3-2）の `note` はこの関数の
 * 対象外 — 後続チケット（T2）がこの層に手を入れやすいよう、意図的に別の
 * 関数として分けておく。
 */
function buildCommittedStartAtChangeNote(
  existing: string | null,
  patchValue: string | null | undefined,
): string | null {
  if (patchValue === undefined || patchValue === existing) {
    return null;
  }
  return `着手の約束を ${existing ?? "null"} から ${patchValue ?? "null"} に変更`;
}

/**
 * Combines the `task_update` `note` fragments produced by the individual
 * `build*ChangeNote` helpers above into the single `note` string persisted
 * on the activity event（決定3: "1回の更新で両方が変わる場合は両方を1つの
 * `note` に含める"）。Fragments that are `null` (the corresponding field
 * didn't change) are dropped; if nothing changed, returns `null` (not an
 * empty string) so callers can keep treating "no note" as `null`.
 */
function combineChangeNotes(...fragments: (string | null)[]): string | null {
  const nonNull = fragments.filter((fragment): fragment is string => fragment !== null);
  return nonNull.length > 0 ? nonNull.join(" / ") : null;
}

/**
 * Applies a partial update to a task. Fields absent from `patch` are left
 * unchanged. When `status` transitions to `done`, `completed_at` is set to
 * the current time; when it transitions away from `done`, `completed_at` is
 * cleared. Returns `{ ok: false, reason: "not_found" }` if no task with the
 * given id exists.
 *
 * **Completion-evidence gate**（機能仕様
 * docs/features/completion-evidence-enforcement.md 決定 2）: when `patch`
 * transitions the task into `done`（決定 2-a: `patch.status === "done" &&
 * existing.status !== "done"` — a transition, not merely "already done", so
 * this never re-blocks an already-`done` task patched on some other field
 * and never retroactively blocks tasks that were `done` before the
 * evidence-enforcement setting existed — 決定4）, and
 * {@link isEvidenceGateBlocking} says the gate blocks (settings ON, the
 * *patch-applied* `evidence_required` value is `true` — 決定 2-c — and the
 * task has zero attached evidence), the whole update is rejected with
 * `{ ok: false, reason: "evidence_required" }` **before** anything is
 * written（決定 2-d: 拒否は「何も書かない」。`status`/`updated_at`/
 * `completed_at` は一切変わらず、`task_update` イベントも記録されない）。
 * This is evaluated before the `db.transaction` below even opens.
 *
 * When the update is not rejected and `patch` requests at least one field, a
 * `task_update` activity event is recorded automatically as part of the same
 * transaction (single input for the slacking-detection rule engine). A patch
 * with no fields (e.g. `PATCH {}`) requests no real change, so it is not
 * treated as an activity signal. When the patch changes `evidence_required`,
 * that event's `note` records the before/after（決定 3-b: 上書きの痕跡は
 * 既存の `task_update` イベントの `note` に載せる。新しいイベント種別は
 * 追加しない）; otherwise `note` stays `null`. This function is the one
 * layer both `PATCH /api/tasks/:id` and the boss's `update_task` tool use
 * pass through, so recording it here covers both call sites.
 */
export function updateTask(
  db: Database.Database,
  id: number,
  patch: TaskPatch,
): UpdateTaskResult {
  const existing = findTaskById(db, id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const next: Task = { ...existing, ...patch };

  const isTransitionToDone =
    patch.status === "done" && existing.status !== "done";
  if (
    isTransitionToDone &&
    isEvidenceGateBlocking(db, {
      taskId: id,
      evidenceRequired: next.evidence_required,
    })
  ) {
    return { ok: false, reason: "evidence_required" };
  }

  let completedAt = existing.completed_at;
  if (patch.status !== undefined) {
    if (patch.status !== "done") {
      completedAt = null;
    } else if (existing.status !== "done") {
      completedAt = new Date().toISOString();
    }
  }

  const now = new Date().toISOString();
  const isRealChange = Object.keys(patch).length > 0;
  const evidenceRequiredChangeNote = buildEvidenceRequiredChangeNote(
    existing.evidence_required,
    patch.evidence_required,
  );

  // 着手の約束（決定1・3）: committed_start_at がこの patch で実際に変わる
  // ときだけ committed_at をこの更新の now に書き換える（取り消し = null な
  // ら committed_at も null）。値が変わらなければ committed_at も note も
  // 変えない。
  const committedStartAtChanged =
    patch.committed_start_at !== undefined &&
    patch.committed_start_at !== existing.committed_start_at;
  const committedAt = committedStartAtChanged
    ? patch.committed_start_at === null
      ? null
      : now
    : existing.committed_at;
  const committedStartAtChangeNote = buildCommittedStartAtChangeNote(
    existing.committed_start_at,
    patch.committed_start_at,
  );
  const note = combineChangeNotes(
    evidenceRequiredChangeNote,
    committedStartAtChangeNote,
  );

  const applyUpdate = db.transaction(() => {
    db.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, priority = ?, due_at = ?, status = ?,
        boss_comment = ?, estimated_minutes = ?, updated_at = ?, completed_at = ?,
        evidence_required = ?, committed_start_at = ?, committed_at = ?
      WHERE id = ?`,
    ).run(
      next.title,
      next.description,
      next.priority,
      next.due_at,
      next.status,
      next.boss_comment,
      next.estimated_minutes,
      now,
      completedAt,
      next.evidence_required ? 1 : 0,
      next.committed_start_at,
      committedAt,
      id,
    );

    if (isRealChange) {
      recordActivityEvent(db, {
        type: "task_update",
        task_id: id,
        note,
      });
    }
  });
  applyUpdate();

  const task = findTaskById(db, id);
  if (!task) {
    throw new Error("failed to read back the updated task");
  }
  return { ok: true, task };
}
