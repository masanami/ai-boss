export const ACTIVITY_EVENT_TYPES = [
  "task_start",
  "break_start",
  "break_end",
  "checkin",
  "chat_message",
  "task_update",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

export interface ActivityEvent {
  id: number;
  type: ActivityEventType;
  task_id: number | null;
  note: string | null;
  expected_minutes: number | null;
  created_at: string;
}
