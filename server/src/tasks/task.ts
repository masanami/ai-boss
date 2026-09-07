export const TASK_STATUSES = ["todo", "in_progress", "paused", "done", "dropped"] as const;
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
   * docs/features/completion-evidence-enforcement.md 決定 2 / 明示的な仮定 8）。
   * HTTP 境界では常に boolean。DB では `tasks.evidence_required INTEGER`
   * （0/1）で持ち、変換は `tasks-repository.ts` の 1 箇所に閉じる。
   */
  evidence_required: boolean;
}
