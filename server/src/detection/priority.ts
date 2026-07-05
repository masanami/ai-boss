import type { Task } from "../tasks/task.js";

const PRIORITY_RANK: Record<NonNullable<Task["priority"]>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
const NO_PRIORITY_RANK = 3;

function priorityRank(priority: Task["priority"]): number {
  return priority === null ? NO_PRIORITY_RANK : PRIORITY_RANK[priority];
}

// Number.MAX_SAFE_INTEGER を「締切なし」の代替値に使う。POSITIVE_INFINITY だと
// due_at が両方 null のとき Infinity - Infinity = NaN になり比較が壊れるため避ける。
function dueAtRank(dueAt: Task["due_at"]): number {
  return dueAt === null ? Number.MAX_SAFE_INTEGER : new Date(dueAt).getTime();
}

/**
 * 最優先タスク（未着手検知・回避検知の対象）を決定する。
 * status が todo/in_progress のタスクの中から
 * priority (high > medium > low > null) → due_at 昇順 (null は最後) → id 昇順 の先頭を返す
 * （Issue #36「明示的な仮定」より）。
 */
export function pickTopPriorityTask(tasks: Task[]): Task | undefined {
  const candidates = tasks.filter(
    (task) => task.status === "todo" || task.status === "in_progress",
  );

  return candidates.sort((a, b) => {
    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const dueDiff = dueAtRank(a.due_at) - dueAtRank(b.due_at);
    if (dueDiff !== 0) return dueDiff;

    return a.id - b.id;
  })[0];
}
