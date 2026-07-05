import type Database from "better-sqlite3";
import type { Task, TaskPriority, TaskStatus } from "./task.js";

/**
 * Returns all tasks ordered by creation time ascending. `id` is used as a
 * tie-breaker so ordering stays deterministic when `created_at` collides
 * (e.g. tasks created within the same second).
 */
export function listTasks(db: Database.Database): Task[] {
  return db
    .prepare("SELECT * FROM tasks ORDER BY created_at ASC, id ASC")
    .all() as Task[];
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
}

export function findTaskById(
  db: Database.Database,
  id: number,
): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Task
    | undefined;
}

/**
 * Inserts a new task with server-managed timestamps and returns the
 * persisted row (all columns, as read back from the database).
 */
export function insertTask(
  db: Database.Database,
  record: NewTaskRecord,
): Task {
  const now = new Date().toISOString();
  const completedAt = record.status === "done" ? now : null;

  const result = db
    .prepare(
      `INSERT INTO tasks (
        title, description, category, priority, due_at, status,
        boss_comment, estimated_minutes, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
}

/**
 * Applies a partial update to a task. Fields absent from `patch` are left
 * unchanged. When `status` transitions to `done`, `completed_at` is set to
 * the current time; when it transitions away from `done`, `completed_at` is
 * cleared. Returns `undefined` if no task with the given id exists.
 */
export function updateTask(
  db: Database.Database,
  id: number,
  patch: TaskPatch,
): Task | undefined {
  const existing = findTaskById(db, id);
  if (!existing) {
    return undefined;
  }

  const next: Task = { ...existing, ...patch };

  let completedAt = existing.completed_at;
  if (patch.status !== undefined) {
    if (patch.status !== "done") {
      completedAt = null;
    } else if (existing.status !== "done") {
      completedAt = new Date().toISOString();
    }
  }

  const now = new Date().toISOString();

  db.prepare(
    `UPDATE tasks SET
      title = ?, description = ?, priority = ?, due_at = ?, status = ?,
      boss_comment = ?, estimated_minutes = ?, updated_at = ?, completed_at = ?
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
    id,
  );

  return findTaskById(db, id);
}
