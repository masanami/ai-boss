import type { Task } from "../tasks/task.js";
import type { ActivityEvent } from "../activity/activity-event.js";

let nextTaskId = 1;

/** テスト用の Task を最小限のデフォルト値で生成するファクトリ */
export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? nextTaskId++;
  return {
    id,
    title: `task-${id}`,
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

let nextActivityEventId = 1;

/** テスト用の ActivityEvent を最小限のデフォルト値で生成するファクトリ */
export function makeActivityEvent(
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  const id = overrides.id ?? nextActivityEventId++;
  return {
    id,
    type: "checkin",
    task_id: null,
    note: null,
    expected_minutes: null,
    created_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}
