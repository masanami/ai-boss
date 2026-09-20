import { createHash } from "node:crypto";
import type { Task } from "../tasks/task.js";

/**
 * Computes a deterministic fingerprint of task state (Issue #121, widened in
 * Issue #542 / 親 #340 スライス S2).
 *
 * Projects each task down to **every field of `Task`** — via an object spread,
 * deliberately without naming fields — so the dashboard "今日のひとこと" cache
 * invalidates whenever a task is created (new `id`), deleted (`id` disappears),
 * or edited **in any way**.
 *
 * It used to project down to `(id, updated_at)` only. `updateTask` writes
 * `new Date().toISOString()` straight into `updated_at` with no monotonicity
 * guarantee, so a second edit landing in the same millisecond (or after an NTP
 * / manual clock rewind) left `updated_at` unchanged, the fingerprint
 * unchanged, and a stale comment served from the cache (機能仕様
 * docs/features/due-at-updated-at-semantics.md 論点(1)・決定 1). Fixing the
 * projection rather than the clock closes the whole class, not just the
 * same-millisecond case. `updated_at` stays in the projection so the previous
 * behaviour is widened, never narrowed.
 *
 * The spread is the point: naming the fields here would create an allowlist
 * that silently goes stale as `Task` grows, and the failure mode ("a stale
 * comment is shown") is hard to notice. Coverage of the projection is instead
 * held by the test side — `task-fingerprint.test.ts` declares its per-field
 * mutation table as `{ [K in keyof Task]: ... }`, so a new field on `Task`
 * surfaces as a `npm run typecheck` failure there.
 *
 * Over-invalidation is cheap by design: the cache is per-calendar-day and
 * already breaks on every edit, so the worst case is one extra LLM call per
 * edit. Consumers (`boss-comment-cache.ts` / `boss-comment.ts`) treat the
 * value as an opaque string, so widening the projection needs no migration —
 * a stored fingerprint simply misses once and is regenerated.
 *
 * Callers must pass tasks in a deterministic order (e.g. `listTasks(db)`,
 * which orders by `created_at ASC, id ASC`) — this function does not sort,
 * since sorting here would hide accidental non-determinism upstream.
 */
export function computeTaskFingerprint(tasks: Task[]): string {
  const projection = tasks.map((task) => ({ ...task }));

  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
