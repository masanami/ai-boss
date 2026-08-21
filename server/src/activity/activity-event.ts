export const ACTIVITY_EVENT_TYPES = [
  "task_start",
  "break_start",
  "break_end",
  "checkin",
  "chat_message",
  "task_update",
  "task_pause",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * Subset of `ActivityEventType` that a user may report explicitly via
 * `POST /api/checkins`. `chat_message` and `task_update` are recorded
 * automatically by the server and are not user-submittable.
 */
export const CHECKIN_TYPES = [
  "task_start",
  "break_start",
  "break_end",
  "checkin",
  "task_pause",
] as const;
export type CheckinType = (typeof CHECKIN_TYPES)[number];

export interface ActivityEvent {
  id: number;
  type: ActivityEventType;
  task_id: number | null;
  note: string | null;
  expected_minutes: number | null;
  created_at: string;
}
