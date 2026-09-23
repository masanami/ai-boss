import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import type { ThresholdScaleSettings } from "./detection-types.js";
import { clamp, diffInMinutes, latestByTimestamp } from "./time-utils.js";

function getLastActivity(
  activityEvents: ActivityEvent[],
): ActivityEvent | undefined {
  return latestByTimestamp(activityEvents, (event) => event.created_at);
}

/**
 * 直近の task_start が指すタスクを返す。ただしそのタスクの現在の status が
 * in_progress でなければ（例: その後 task_pause された場合）undefined を返す
 * （#179 判断4）。一時停止したタスクの見積もりを無音許容時間の
 * 根拠に使い続けないため、フォールバック値へ倒す。
 */
function getInProgressTask(
  activityEvents: ActivityEvent[],
  tasks: Task[],
): Task | undefined {
  const taskStarts = activityEvents.filter(
    (event) => event.type === "task_start" && event.task_id !== null,
  );
  const lastTaskStart = latestByTimestamp(taskStarts, (event) => event.created_at);
  if (!lastTaskStart) return undefined;
  const task = tasks.find((task) => task.id === lastTaskStart.task_id);
  if (!task || task.status !== "in_progress") return undefined;
  return task;
}

/**
 * 無音検知の閾値（分）。直近の task_start が指す進行中タスクに estimated_minutes
 * があればスケール、無ければフォールバック（既定 45 分）を使う
 * （Issue #36「明示的な仮定」より）。
 */
export function computeSilenceThresholdMinutes(
  activityEvents: ActivityEvent[],
  tasks: Task[],
  settings: ThresholdScaleSettings,
): number {
  const inProgressTask = getInProgressTask(activityEvents, tasks);
  if (inProgressTask && inProgressTask.estimated_minutes !== null) {
    return clamp(
      inProgressTask.estimated_minutes * settings.scale,
      settings.min,
      settings.max,
    );
  }
  return settings.fallback;
}

/**
 * 無音検知: 最後の活動シグナル（全種）から閾値時間が経過しているか。
 * 活動シグナルが一件も無い場合は基準点が無いため発火しない（起動直後の誤検知回避）。
 */
export function isSilent(
  now: Date,
  activityEvents: ActivityEvent[],
  tasks: Task[],
  settings: ThresholdScaleSettings,
): boolean {
  const lastActivity = getLastActivity(activityEvents);
  if (!lastActivity) return false;

  const threshold = computeSilenceThresholdMinutes(activityEvents, tasks, settings);
  const elapsed = diffInMinutes(now, new Date(lastActivity.created_at));
  return elapsed >= threshold;
}
