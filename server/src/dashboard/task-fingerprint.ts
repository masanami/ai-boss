import { createHash } from "node:crypto";
import type { Task } from "../tasks/task.js";

/**
 * Computes a deterministic fingerprint of task state (Issue #121, 案A).
 *
 * Projects each task down to `(id, updated_at)` only — not the full task
 * body — so the dashboard "今日のひとこと" cache invalidates whenever a
 * task is created (new `id`), edited (`updated_at` changes), or (in the
 * future) deleted (`id` disappears), without being sensitive to fields that
 * don't affect what the boss would say (KISS: minimal projection).
 *
 * Callers must pass tasks in a deterministic order (e.g. `listTasks(db)`,
 * which orders by `created_at ASC, id ASC`) — this function does not sort,
 * since sorting here would hide accidental non-determinism upstream.
 */
export function computeTaskFingerprint(tasks: Task[]): string {
  const projection = tasks.map((task) => ({
    id: task.id,
    updated_at: task.updated_at,
  }));

  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
