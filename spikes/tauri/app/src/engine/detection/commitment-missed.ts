import type { Task } from "../tasks/task.js";
import type { NotificationHistoryEntry } from "./detection-types.js";

/**
 * 着手の約束の時刻を過ぎても未着手か（機能仕様
 * docs/features/task-start-commitment.md 決定 4 の 1）。猶予は 0 分
 * （`now >= committed_start_at`）。`in_progress`/`paused`/`done`/`dropped` は
 * 対象外（未着手の定義 C1 と揃える）。
 */
export function hasMissedCommitment(task: Task, now: Date): boolean {
  if (task.status !== "todo") return false;
  if (task.committed_start_at === null) return false;
  return now.getTime() >= new Date(task.committed_start_at).getTime();
}

/**
 * 約束の時刻を過ぎても未着手のタスクをすべて返す。最優先タスクに限らず全件を
 * ループで評価する（`deadline-overdue.ts` の `findOverdueTasks` と同形。決定 4
 * の 2）。
 */
export function findMissedCommitmentTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => hasMissedCommitment(task, now));
}

/**
 * `commitment_missed` の rule_key。`committed_at`（約束を置いた時刻）を含める
 * ことで、約束を置き直すと（同じ時刻へ戻した場合を含め）別のインスタンスとして
 * 扱われ、通知履歴を引き継がない（決定 4 の 3・決定 1）。
 *
 * `hasMissedCommitment` が真のタスクにのみ呼ぶ前提（`committed_start_at` /
 * `committed_at` はどちらも非 `null`。`tasks.committed_at` の不変条件）。
 */
export function buildCommitmentMissedRuleKey(task: Task): string {
  return `commitment_missed:${task.id}:${task.committed_start_at}:${task.committed_at}`;
}

/**
 * 勤務時間帯外の `commitment_missed` 専用の発火判定: その rule_key の通知履歴が
 * 1 件も無いか。真なら L1 で 1 回だけ発火し、`resolveEscalation` は呼ばない
 * （段階を上げない・活動シグナルによるリセットもしない。決定 4 の 6・ADR 0004
 * 改訂）。
 */
export function hasNoHistoryForRuleKey(
  ruleKey: string,
  notifications: NotificationHistoryEntry[],
): boolean {
  return !notifications.some((entry) => entry.ruleKey === ruleKey);
}
