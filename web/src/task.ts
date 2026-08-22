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
}

export interface NewTaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  due_at?: string | null;
}

export interface TaskPatchInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority | null;
  due_at?: string | null;
  status?: TaskStatus;
  boss_comment?: string | null;
}
