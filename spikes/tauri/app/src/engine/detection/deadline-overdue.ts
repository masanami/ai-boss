import type { Task } from "../tasks/task.js";
import { toDueAtInstant } from "../tasks/due-at.js";

/**
 * 締切超過検知: due_at を過ぎた未完了（todo / in_progress / paused）タスクを返す。
 * paused は締切を止めないため対象に含める（#179 判断4）。
 *
 * `due_at` は**ローカル暦日**であり、締切が切れるのは締切の暦日 `D` の翌ローカル
 * 暦日 `D+1` の 00:00 である（ADR 0010 決定 2。`D+1` 00:00 ちょうどはまだ超過では
 * ない）。この解釈は `tasks/due-at.ts` に集約されており、ここで `new Date(due_at)`
 * を直接呼ばない（決定 5）。締切なし・暦として解釈できない値はいずれも
 * `toDueAtInstant` が `null` を返し、締切超過にはしない（決定 6）。
 */
export function findOverdueTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => {
    if (
      task.status !== "todo" &&
      task.status !== "in_progress" &&
      task.status !== "paused"
    )
      return false;
    const dueInstant = toDueAtInstant(task.due_at);
    if (dueInstant === null) return false;
    return dueInstant < now.getTime();
  });
}
