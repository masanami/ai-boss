import type { ActivityEvent, CheckinInput } from "./activity-event";

const CHECKINS_URL = "/api/checkins";
const ACTIVITY_TODAY_URL = "/api/activity/today";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Submits an explicit checkin (task_start / break_start / break_end /
 * checkin) and returns the created activity event.
 */
export async function postCheckin(input: CheckinInput): Promise<ActivityEvent> {
  const response = await fetch(CHECKINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as ActivityEvent;
}

/**
 * Fetches today's activity events (ascending by created_at).
 */
export async function fetchTodayActivity(): Promise<ActivityEvent[]> {
  const response = await fetch(ACTIVITY_TODAY_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as ActivityEvent[];
}
