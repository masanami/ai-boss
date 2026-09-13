export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "paused",
  "done",
  "dropped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: number;
  title: string;
  description: string | null;
  category: string;
  priority: TaskPriority | null;
  due_at: string | null;
  status: TaskStatus;
  boss_comment: string | null;
  estimated_minutes: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /**
   * 完了報告にエビデンスが要るか（機能仕様
   * docs/features/completion-evidence-enforcement.md 明示的な仮定 8）。DB は
   * INTEGER だが HTTP 境界では常に boolean（`server/src/tasks/tasks-repository.ts`
   * の `mapTaskRow` が変換する）。
   */
  evidence_required: boolean;
  /**
   * 着手の約束（機能仕様 docs/features/task-start-commitment.md 決定1・7）。
   * `null` は「約束なし」。`todo` 以外のタスクでは常に `null`（決定3-2）。
   * 入力・変更の UI はこの web には無い（決定7・ボスの会話経由でのみ変わる）。
   */
  committed_start_at: string | null;
  /**
   * その約束を置いた時刻（同上・決定1）。画面には表示しない
   * （`committed_start_at` の識別用の内部項目）。
   */
  committed_at: string | null;
}

export interface NewTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  due_at?: string | null;
  /** 省略時サーバ既定は `false`（`TaskForm` は明示的なチェックボックスで送る）。 */
  evidence_required?: boolean;
}

export interface TaskPatchInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority | null;
  due_at?: string | null;
  status?: TaskStatus;
  boss_comment?: string | null;
  evidence_required?: boolean;
}
