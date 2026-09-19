import { isSameLocalDay } from "./is-same-local-day";
import type { Task } from "./task";

/**
 * サイドパネル「今日のタスク」の対象を判定する純粋関数。
 * 対象の定義はサーバーのノルマ進捗（server/src/dashboard/progress.ts）と同じ:
 * 現在 todo / in_progress / paused のタスク（一時停止中も放棄していないため含める
 * — #179）+ 今日（ローカル日付）完了したタスク。
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

/**
 * サイドパネル「今日のタスク」の表示層向けに、selectTodayTasks の戻り値を
 * 未完了（pending）と完了（done）へ分ける純粋関数（#427）。selectTodayTasks
 * 自体は対象集合（進捗ゲージの分母・分子）を変えないため無改変のまま、
 * この関数は表示のための分類だけを担う（並び替えはしない）。各グループ内の
 * 要素順は入力の順序を保ち、入力配列は破壊しない。
 */
export function partitionTodayTasks(tasks: Task[]): {
  pending: Task[];
  done: Task[];
} {
  const pending: Task[] = [];
  const done: Task[] = [];
  for (const task of tasks) {
    if (task.status === "done") {
      done.push(task);
    } else {
      pending.push(task);
    }
  }
  return { pending, done };
}
