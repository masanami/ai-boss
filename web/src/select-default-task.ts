import type { Task } from "./task";

const PRIORITY_RANK: Record<"high" | "medium" | "low", number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function priorityRank(task: Task): number {
  return task.priority === null ? 3 : PRIORITY_RANK[task.priority];
}

/**
 * Picks the task that should be pre-selected as the default target for a
 * "着手" (task_start) checkin: the highest-priority task, breaking ties by
 * the smaller id (stable, deterministic default among equally-prioritized
 * tasks).
 */
export function selectDefaultTask(tasks: Task[]): Task | undefined {
  return tasks.reduce<Task | undefined>((best, task) => {
    if (best === undefined) {
      return task;
    }
    const rankDiff = priorityRank(task) - priorityRank(best);
    if (rankDiff < 0 || (rankDiff === 0 && task.id < best.id)) {
      return task;
    }
    return best;
  }, undefined);
}
