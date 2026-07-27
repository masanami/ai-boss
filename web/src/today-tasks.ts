import { isSameLocalDay } from "./is-same-local-day";
import type { Task } from "./task";

/**
 * サイドパネル「今日のタスク」の対象を判定する純粋関数。
 * 対象の定義はサーバーのノルマ進捗（server/src/dashboard/progress.ts）と同じ:
 * 現在 todo / in_progress のタスク + 今日（ローカル日付）完了したタスク。
 */
export function selectTodayTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    if (task.status === "todo" || task.status === "in_progress") {
      return true;
    }
    if (task.status === "done") {
      return (
        task.completed_at !== null &&
        isSameLocalDay(new Date(task.completed_at), now)
      );
    }
    // dropped
    return false;
  });
}
