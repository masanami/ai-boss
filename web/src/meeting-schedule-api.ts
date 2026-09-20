import type { MeetingScheduleResponse, MeetingSchedulePatch } from "./meeting-schedule";

function meetingScheduleUrl(date: string): string {
  return `/api/meeting-schedule/${date}`;
}

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Fetches today's meeting schedule (morning/evening effective times, whether
 * each is overridden, and the latest allowed override time) for the given
 * local date key. Throws when the response is not ok so callers can
 * distinguish success from failure.
 */
export async function fetchMeetingSchedule(date: string): Promise<MeetingScheduleResponse> {
  const response = await fetch(meetingScheduleUrl(date));
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as MeetingScheduleResponse;
}

/**
 * Applies a partial override update (`null` clears an override back to the
 * default) and returns the resulting schedule in the same shape as
 * `fetchMeetingSchedule`, so callers can update their display directly from
 * the PUT response without re-fetching (decision 9 /
 * docs/features/today-meeting-time-override.md).
 */
export async function updateMeetingSchedule(
  date: string,
  patch: MeetingSchedulePatch,
): Promise<MeetingScheduleResponse> {
  const response = await fetch(meetingScheduleUrl(date), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as MeetingScheduleResponse;
}
