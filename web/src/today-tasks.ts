import { isSameLocalDay } from "./is-same-local-day";
import type { Task } from "./task";

/**
 * サイドパネル「今日のタスク」の対象を判定する純粋関数。
 * 対象の定義はサーバーのノルマ進捗（server/src/dashboard/progress.ts）と同じ:
 * 現在 todo / in_progress / paused のタスク（一時停止中も放棄していないため含める
 * — G-179-11／G-170-112 改訂）+ 今日（ローカル日付）完了したタスク。
 */
export function selectTodayTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    switch (task.status) {
      case "todo":
      case "in_progress":
      case "paused":
        return true;
      case "done":
        return (
          task.completed_at !== null &&
          isSameLocalDay(new Date(task.completed_at), now)
        );
      case "dropped":
        return false;
      default:
        // TaskStatus に新しい値が追加されたら型エラーで気づけるようにする。
        // 実行時に未知の値が渡っても対象外（false）に倒す。
        task.status satisfies never;
        return false;
    }
  });
}
