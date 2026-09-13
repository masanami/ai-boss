import type { Task } from "./task";
import type { TasksLoadStatus } from "./use-tasks";

/**
 * A slice of a piece of boss-authored text (S1: `docs/features/boss-reply-task-id-hover.md`):
 * either plain text, or a `#<id>` run that resolved to a task in the caller's
 * list. Concatenating every segment's `text` in order always reproduces the
 * original input verbatim (受入基準: 装飾の有無にかかわらず textContent が一致する) —
 * an unresolved `#<id>` is not distinguished from surrounding plain text here,
 * it just stays part of the neighboring `"text"` segment.
 */
export type TaskIdReferenceSegment =
  | { kind: "text"; text: string }
  | { kind: "task-reference"; text: string; task: Task };

// 決定3: 半角 `#` の直後の半角数字の最長の並び。`#` の直前の文字には条件を
// 付けない。全角 `＃`・全角数字はこの文字クラスに含まれないため自動的に対象外。
const TASK_ID_PATTERN = /#([0-9]+)(?![0-9])/g;

/**
 * The task list `resolveTaskIdReferences` may resolve against: the list only
 * once it has actually loaded, `null` otherwise (決定3: loading / error のとき
 * は原文のまま). Omitted props (`status === undefined`) count as unavailable.
 * Shared by `ChatView` and `DecisionLog` so the status rule lives in one place.
 */
export function referenceableTasks(
  tasks: readonly Task[] | undefined,
  status: TasksLoadStatus | undefined,
): readonly Task[] | null {
  return status === "ready" ? (tasks ?? []) : null;
}

/**
 * Splits `text` into plain-text and task-reference segments, resolving each
 * `#<id>` run against `tasks` (決定3).
 *
 * `tasks === null` represents "the task list is not available" (loading /
 * error, 決定3) — every `#<id>` is left unresolved in that case, matching the
 * "一覧が loading/error のときは原文のまま表示する" requirement without the
 * caller having to special-case it before calling in.
 *
 * A digit run resolves only when it is the exact decimal representation of
 * some task's `id` (`String(task.id)`), so a leading zero (`#01`) never
 * matches `id: 1`.
 *
 * Pure function: does not mutate `tasks`.
 */
export function resolveTaskIdReferences(
  text: string,
  tasks: readonly Task[] | null,
): TaskIdReferenceSegment[] {
  if (tasks === null) {
    return [{ kind: "text", text }];
  }

  const taskById = new Map(tasks.map((task) => [String(task.id), task]));
  const segments: TaskIdReferenceSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TASK_ID_PATTERN)) {
    const task = taskById.get(match[1]);
    if (task === undefined) {
      // 一覧に無い ID: 周囲の平文に混ぜたままにする（原文のまま表示）。
      continue;
    }
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: "task-reference", text: match[0], task });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length || segments.length === 0) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments;
}
