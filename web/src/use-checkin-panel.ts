import { useCallback, useEffect, useState } from "react";
import { fetchTodayActivity, postCheckin } from "./checkins-api";
import { deriveIsOnBreak } from "./derive-break-status";
import type { ActivityEvent, CheckinInput } from "./activity-event";

export type ActivityLoadStatus = "loading" | "ready" | "error";

export interface UseCheckinPanelResult {
  events: ActivityEvent[];
  status: ActivityLoadStatus;
  isOnBreak: boolean;
  submitError: string | null;
  submitCheckin: (input: CheckinInput) => Promise<boolean>;
}

/**
 * Loads today's activity events on mount and exposes a `submitCheckin`
 * action that posts an explicit checkin, then refetches the list so the
 * panel reflects the new state. Mirrors the fetch-on-mount pattern used by
 * `useTasks`.
 */
export function useCheckinPanel(): UseCheckinPanelResult {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [status, setStatus] = useState<ActivityLoadStatus>("loading");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchTodayActivity()
      .then((fetched) => {
        if (!cancelled) {
          setEvents(fetched);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const submitCheckin = useCallback(async (input: CheckinInput) => {
    try {
      await postCheckin(input);
      setSubmitError(null);
      const refetched = await fetchTodayActivity();
      setEvents(refetched);
      return true;
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "送信に失敗しました",
      );
      return false;
    }
  }, []);

  return {
    events,
    status,
    isOnBreak: deriveIsOnBreak(events),
    submitError,
    submitCheckin,
  };
}
