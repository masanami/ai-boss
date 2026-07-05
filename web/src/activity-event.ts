export const ACTIVITY_EVENT_TYPES = [
  "task_start",
  "break_start",
  "break_end",
  "checkin",
  "chat_message",
  "task_update",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * Subset of `ActivityEventType` that a user may report explicitly via
 * `POST /api/checkins`. Mirrors `server/src/activity/activity-event.ts`.
 */
export const CHECKIN_TYPES = [
  "task_start",
  "break_start",
  "break_end",
  "checkin",
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

export interface CheckinInput {
  type: CheckinType;
  task_id?: number | null;
  note?: string | null;
  expected_minutes?: number | null;
}
