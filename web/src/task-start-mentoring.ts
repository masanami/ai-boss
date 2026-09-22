import type { DecisionRecord } from "./decision";
import type { Task } from "./task";

/**
 * 共有 `tasks` の前回値と今回値から「着手」＝ `todo` → `in_progress` へ
 * 変わったタスクを抽出する（Issue #566 決定2・決定8）。
 *
 * 経路（select・drop・チェックイン後の再取得）は問わず、結果の状態だけを
 * 比べる。前回に無いタスク（初回読み込み・新規作成）は遷移とみなさない
 * （AC-11）。`paused` → `in_progress`（再開）は着手ではないので対象外。
 */
export function detectTaskStarts(previous: Task[], current: Task[]): Task[] {
  const previousStatusById = new Map(
    previous.map((task) => [task.id, task.status]),
  );
  return current.filter(
    (task) =>
      task.status === "in_progress" &&
      previousStatusById.get(task.id) === "todo",
  );
}

/**
 * 見積もり・進め方が「未確認」か（Issue #566 決定3）。見積もりが空、
 * **または**そのタスクに紐づく `kind: "mentoring"` の記録が 1 件も無ければ
 * 未確認。記録の `status` は問わない（`withdrawn` でも確認済みに数える）。
 *
 * 呼び出し側は `estimated_minutes` が `null` なら記録を取得せずに未確認と
 * 判定してよい（その場合 `decisions` は結果に影響しない）。
 */
export function isMentoringUnconfirmed(
  task: Task,
  decisions: DecisionRecord[],
): boolean {
  if (task.estimated_minutes === null) {
    return true;
  }
  return !decisions.some(
    (record) => record.kind === "mentoring" && record.task_id === task.id,
  );
}
