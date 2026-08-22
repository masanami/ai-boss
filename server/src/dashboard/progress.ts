import type { Task } from "../tasks/task.js";
import { toDateKey } from "../detection/time-utils.js";
import type { DashboardProgress } from "./dashboard.js";

/**
 * 今日のノルマ対象タスクを判定する（純粋関数、Issue #58 明示的な仮定）。
 * 対象 = 今日完了したタスク（completed_at がローカル日付で今日）
 *      + 現在 todo / in_progress / paused のタスク（#179）。
 * dropped、および過去日に完了したタスクは対象外。
 */
function isTargetTask(task: Task, todayKey: string): boolean {
  switch (task.status) {
    case "todo":
    case "in_progress":
    case "paused":
      return true;
    case "done":
      return (
        task.completed_at !== null && toDateKey(new Date(task.completed_at)) === todayKey
      );
    case "dropped":
      return false;
    default:
      // TaskStatus に新しい値が追加されたら型エラーで気づけるようにする
      // （web/src/today-tasks.ts の selectTodayTasks と同じ規律）。実行時に
      // 未知の値が渡っても対象外（false）に倒す。
      task.status satisfies never;
      return false;
  }
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
