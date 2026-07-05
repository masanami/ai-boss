import type { Task } from "../tasks/task.js";
import type { ThresholdScaleSettings } from "./detection-types.js";
import { clamp, diffInMinutes } from "./time-utils.js";

/**
 * 未着手検知の閾値（分）。estimated_minutes が確認済みならスケールしてクランプ、
 * 未確認ならフォールバック（既定 60 分）を使う（Issue #36「明示的な仮定」より）。
 */
export function computeUnstartedThresholdMinutes(
  task: Task,
  settings: ThresholdScaleSettings,
): number {
  if (task.estimated_minutes === null) {
    return settings.fallback;
  }
  return clamp(task.estimated_minutes * settings.scale, settings.min, settings.max);
}

/**
 * 最優先タスクが todo のまま閾値時間を超過しているか。
 * 経過時間の起点はタスク作成時刻（created_at）とする
 * （優先度が付与された時刻を追跡していないための実装上の仮定）。
 */
export function isTopTaskUnstarted(
  task: Task,
  now: Date,
  settings: ThresholdScaleSettings,
): boolean {
  if (task.status !== "todo") return false;

  const threshold = computeUnstartedThresholdMinutes(task, settings);
  const elapsed = diffInMinutes(now, new Date(task.created_at));
  return elapsed >= threshold;
}
