import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import { diffInMinutes } from "./time-utils.js";

const OTHER_TASK_ACTIVITY_TYPES = ["task_start", "task_update"] as const;

/**
 * 回避検知: 直近 windowMinutes 以内に、最優先タスク以外への task_start /
 * task_update があるか（Issue #36「明示的な仮定」の回避検知の窓より）。
 */
export function hasRecentActivityOnOtherTasks(
  topTask: Task,
  now: Date,
  activityEvents: ActivityEvent[],
  windowMinutes: number,
): boolean {
  return activityEvents.some((event) => {
    if (!(OTHER_TASK_ACTIVITY_TYPES as readonly string[]).includes(event.type)) {
      return false;
    }
    if (event.task_id === null || event.task_id === topTask.id) {
      return false;
    }
    return diffInMinutes(now, new Date(event.created_at)) <= windowMinutes;
  });
}
