import type { Task } from "../tasks/task.js";
import { toDateKey } from "../detection/time-utils.js";
import type { DashboardProgress } from "./dashboard.js";

/**
 * 今日のノルマ対象タスクを判定する（純粋関数、Issue #58 明示的な仮定）。
 * 対象 = 今日完了したタスク（completed_at がローカル日付で今日）
 *      + 現在 todo / in_progress のタスク。
 * dropped、および過去日に完了したタスクは対象外。
 */
function isTargetTask(task: Task, todayKey: string): boolean {
  if (task.status === "todo" || task.status === "in_progress") {
    return true;
  }
  if (task.status === "done") {
    return (
      task.completed_at !== null && toDateKey(new Date(task.completed_at)) === todayKey
    );
  }
  // dropped
  return false;
}

/**
 * 今日のノルマ達成状況を計算する純粋関数。入力（タスク一覧 + 現在時刻）から
 * 出力（done / total / ratio）を返す。対象タスクが0件の場合、ratio は 0
 * とする（0除算を避ける）。
 */
export function calculateProgress(tasks: Task[], now: Date): DashboardProgress {
  const todayKey = toDateKey(now);
  const targetTasks = tasks.filter((task) => isTargetTask(task, todayKey));
  const done = targetTasks.filter((task) => task.status === "done").length;
  const total = targetTasks.length;
  const ratio = total === 0 ? 0 : done / total;

  return { done, total, ratio };
}
