import type { Task } from "../tasks/task.js";

/**
 * 締切超過検知: due_at を過ぎた未完了（todo / in_progress / paused）タスクを返す。
 * paused は締切を止めないため対象に含める（#179 判断4。G-179-8）。
 */
export function findOverdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    if (
      task.status !== "todo" &&
      task.status !== "in_progress" &&
      task.status !== "paused"
    )
      return false;
    if (task.due_at === null) return false;
    return new Date(task.due_at).getTime() < now.getTime();
  });
}
