import { isSameLocalDay } from "./is-same-local-day";
import type { Task } from "./task";

/**
 * サイドパネル「今日のタスク」の対象を判定する純粋関数。
 * 対象の定義はサーバーのノルマ進捗（server/src/dashboard/progress.ts）と同じ:
 * 現在 todo / in_progress のタスク + 今日（ローカル日付）完了したタスク。
 */
export function selectTodayTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    switch (task.status) {
      case "todo":
      case "in_progress":
        return true;
      case "done":
        return (
          task.completed_at !== null &&
          isSameLocalDay(new Date(task.completed_at), now)
        );
      case "paused":
        // 暫定: paused を対象へ含める変更（G-170-112 の改訂）は #187 の担当。
        // この時点では paused を作る経路（task_pause チェックイン）が未実装のため到達しない。
        return false;
      case "dropped":
        return false;
      default:
        // TaskStatus に新しい値が追加されたら型エラーで気づけるようにする
        return task.status satisfies never;
    }
  });
}
