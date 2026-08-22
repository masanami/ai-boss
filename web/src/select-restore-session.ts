import type { ChatSession } from "./chat";
import { isSameLocalDay } from "./is-same-local-day";

export interface RestoreSessions {
  /**
   * The session to show as "active" on mount/reload: today's most recently
   * started unfinished morning/evening session (so an in-progress meeting
   * survives a tab switch or a page reload), or today's latest unfinished
   * adhoc session when no meeting is open.
   */
  active: ChatSession | null;
  /**
   * Today's latest unfinished adhoc session, returned separately from
   * `active` so the caller can restore the adhoc conversation as the return
   * point when a restored meeting is ended (mirrors `useChat`'s
   * `adhocSnapshotRef`). An already-ended adhoc session is treated the same
   * as having no adhoc session at all, so it is never picked here.
   */
  adhoc: ChatSession | null;
}

/**
 * Picks which sessions `useChat` should restore on mount from the full
 * (unfiltered) session list. Only today's (local day) sessions are
 * considered — a session from a previous day is left alone, matching the
 * existing daily-scope behavior of adhoc chat.
 *
 * Sessions are sorted defensively by `started_at` descending (ties broken by
 * the larger `id`) instead of trusting the API's ordering, since this
 * function's correctness must not depend on a call-site assumption.
 */
export function selectRestoreSessions(
  sessions: ChatSession[],
  now: Date,
): RestoreSessions {
  const todays = sessions.filter((session) =>
    isSameLocalDay(now, new Date(session.started_at)),
  );
  const sorted = [...todays].sort((a, b) => {
    const byStartedAt =
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
    return byStartedAt !== 0 ? byStartedAt : b.id - a.id;
  });

  const openMeeting =
    sorted.find(
      (session) =>
        (session.type === "morning" || session.type === "evening") &&
        session.ended_at === null,
    ) ?? null;
  const adhoc =
    sorted.find(
      (session) => session.type === "adhoc" && session.ended_at === null,
    ) ?? null;

  return { active: openMeeting ?? adhoc, adhoc };
}
