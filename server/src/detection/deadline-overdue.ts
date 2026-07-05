import type { Task } from "../tasks/task.js";

/** 締切超過検知: due_at を過ぎた未完了（todo / in_progress）タスクを返す */
export function findOverdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    if (task.status !== "todo" && task.status !== "in_progress") return false;
    if (task.due_at === null) return false;
    return new Date(task.due_at).getTime() < now.getTime();
  });
}
