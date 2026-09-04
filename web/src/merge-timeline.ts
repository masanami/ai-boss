import type { ChatEntry, ChatMessage, ChatSession, MeetingSessionType } from "./chat";
import { isSameLocalDay } from "./is-same-local-day";

/** A session paired with the messages fetched for it. */
export interface LoadedSession {
  session: ChatSession;
  messages: ChatMessage[];
}

/**
 * Picks the sessions whose conversation belongs in the unified timeline
 * (Issue #272 判断6): today's (local calendar day) sessions, **plus any
 * pinned session even when it started on a previous day**.
 *
 * The day-crossing correction is not optional. [ADR 0007](../../docs/adr/0007-local-calendar-day-basis.md)
 * 決定4 attributes a meeting to its **start** day, so an evening session
 * opened at 23:50 stops being "today's" at 00:00 — without this correction
 * the history would vanish from the screen mid-meeting. Scoping the
 * correction to *pinned* sessions (rather than "any unfinished session")
 * keeps it bounded: a stale unfinished session from days ago is still left
 * behind, matching `selectRestoreSessions`'s existing daily scope.
 *
 * Callers pin the session they are acting on: the active one, and — in
 * `endSession` — the meeting just ended, which must not vanish from the
 * screen the moment it is closed on the far side of midnight.
 *
 * Sorted by `started_at` ascending with `id` ascending as a tie-breaker, so
 * the caller can fetch and merge in a deterministic order.
 */
export function selectTimelineSessions(
  sessions: ChatSession[],
  now: Date,
  pinnedSessionIds: readonly (number | null)[],
): ChatSession[] {
  return sessions
    .filter(
      (session) =>
        isSameLocalDay(now, new Date(session.started_at)) ||
        pinnedSessionIds.includes(session.id),
    )
    .sort((a, b) => {
      const byStartedAt =
        new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
      return byStartedAt !== 0 ? byStartedAt : a.id - b.id;
    });
}

/**
 * Ordering phase for entries sharing a timestamp. A meeting's start boundary
 * must precede messages stored at the same instant (the meeting-opening line
 * of Issue #271 can land on the very millisecond of `started_at`), and its
 * end boundary must follow them.
 */
const PHASE_START = 0;
const PHASE_MESSAGE = 1;
const PHASE_END = 2;

interface SortableEntry {
  at: number;
  phase: number;
  /** Message id, or 0 for boundaries — makes ties between messages stored at
   * the same instant deterministic (same rule as the server's
   * `listMessagesBySessionId`: created_at ascending, id ascending). */
  id: number;
  entry: ChatEntry;
}

function isMeeting(session: ChatSession): session is ChatSession & {
  type: MeetingSessionType;
} {
  return session.type !== "adhoc";
}

/**
 * Merges the given sessions' messages, plus derived meeting boundaries, into
 * one timeline ordered by timestamp ascending.
 *
 * This is the single place the merge ordering is expressed, so the rule is
 * pinned by this module's unit tests rather than being re-derived at each
 * call site in `use-chat.ts`.
 */
export function buildTimeline(loaded: LoadedSession[]): ChatEntry[] {
  const sortable: SortableEntry[] = [];

  for (const { session, messages } of loaded) {
    if (isMeeting(session)) {
      sortable.push({
        at: new Date(session.started_at).getTime(),
        phase: PHASE_START,
        id: 0,
        entry: {
          kind: "boundary",
          key: `boundary-${session.id}-start`,
          sessionType: session.type,
          event: "start",
        },
      });
      // 明示的な仮定5: an open meeting gets its start boundary only — the end
      // boundary appears once `ended_at` is set.
      if (session.ended_at !== null) {
        sortable.push({
          at: new Date(session.ended_at).getTime(),
          phase: PHASE_END,
          id: 0,
          entry: {
            kind: "boundary",
            key: `boundary-${session.id}-end`,
            sessionType: session.type,
            event: "end",
          },
        });
      }
    }

    for (const message of messages) {
      sortable.push({
        at: new Date(message.created_at).getTime(),
        phase: PHASE_MESSAGE,
        id: message.id,
        entry: {
          kind: "message",
          key: `message-${message.id}`,
          role: message.role,
          content: message.content,
          // Issue #254: carried through from the server so a reply that was
          // cut short still reads as cut short after a reload, not as a
          // boss who inexplicably stopped mid-sentence.
          //
          // Only set when true, so a complete message keeps exactly the
          // shape it had before this field existed — `interrupted` marks
          // the exception, and entries are compared by deep equality in
          // this module's tests.
          ...(message.interrupted === 1 ? { interrupted: true } : {}),
        },
      });
    }
  }

  return sortable
    .sort(
      (a, b) => a.at - b.at || a.phase - b.phase || a.id - b.id,
    )
    .map((item) => item.entry);
}
