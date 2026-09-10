import type { Task } from "./task";
import { toDateKey } from "./to-date-key";

/**
 * 「完了」「中止」列（＝終端ステータスの列）の絞り込みに使う基準時刻を返す
 * （Issue #428 / #437 決定 3）。
 *
 * `done` は `completed_at`、`dropped` は `updated_at` を基準にする。`dropped`
 * には中止時刻を保持する列が無く（`dropped_at` はスキーマ・型のどこにも存在
 * しない）、さらに `updateTask`（server/src/tasks/tasks-repository.ts）は
 * `done` 以外への遷移で `completed_at` を `null` にクリアするため、中止タスク
 * の時刻を示すのは `updated_at` だけである。
 *
 * `todo` / `in_progress` / `paused` は絞り込みの対象外（片付けば列から消える
 * ので単調増加しない）なので `null` を返す。`done` かつ `completed_at` が
 * `null` の場合も `null` を返し、呼び出し側で範囲外へ倒す（決定 4。
 * `today-tasks.ts` が `completed_at !== null` を条件に持つのと同じ倒し方）。
 */
export function terminalReferenceAt(task: Task): string | null {
  switch (task.status) {
    case "done":
      return task.completed_at;
    case "dropped":
      return task.updated_at;
    case "todo":
    case "in_progress":
    case "paused":
      return null;
    default:
      // TaskStatus に新しい値が追加されたら型エラーで気づけるようにする。
      // 実行時に未知の値が渡っても対象外（null）に倒す。
      task.status satisfies never;
      return null;
  }
}

/**
 * `reference` が「`now` を含む直近 `windowDays` 暦日（ローカル）」に入るか。
 * `reference` が `null`（＝基準時刻が取れない）なら `false`。
 *
 * 下限は**暦日を進退させて**求める（ADR 0007 決定 3: 固定秒数の加算をしない。
 * DST のある地域では 24 時間 ≠ 1 暦日になるため）。日付キーの導出は
 * `to-date-key.ts` の `toDateKey` に集約する（ADR 0007 決定 2）。
 *
 * 上限側（未来方向）は絞らない。時計のずれや当日中の更新で `now` より未来の
 * 値が入ったときにカードが消えるほうが不都合で、本課題は古い側が溜まること
 * だけを扱うため（明示的な仮定 3）。
 */
export function isWithinRecentLocalDays(
  reference: string | null,
  now: Date,
  windowDays: number,
): boolean {
  if (reference === null) {
    return false;
  }
  const referenceDate = new Date(reference);
  if (Number.isNaN(referenceDate.getTime())) {
    // 読めない基準時刻も「取れない」側＝範囲外へ倒す（決定 4 と同じ倒し方）。
    // toDateKey は Invalid Date に "NaN-NaN-NaN" を返し、辞書順比較では下限より
    // 大きいと判定されてしまう（＝黙って列に残り続け、本課題が再発する）。
    return false;
  }
  // windowDays は「当日を含む」日数なので、下限の暦日は windowDays - 1 日前。
  const lowerBound = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (windowDays - 1),
  );
  return toDateKey(referenceDate) >= toDateKey(lowerBound);
}
