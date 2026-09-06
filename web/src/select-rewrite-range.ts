import type { ChatEntry } from "./chat";

/**
 * The set of entries that a rewrite (Issue #377, 決定 6) would delete, and the
 * message counts to show in the confirmation UI before the user commits to
 * it. This count is the **sole safeguard against an irreversible truncation**
 * (決定 6) — under- or over-reporting it defeats that safeguard, which is why
 * this function scopes everything to `activeSessionId` (導出決定 6-a) rather
 * than "everything below the target on screen". One narrow, deliberate
 * exception to "never under-report": `send`'s own optimistic user-message
 * entry has no `messageId`/`sessionId` yet (AC-38b — the server never tells
 * the client that message's persisted id), so this function cannot count it
 * even though the server would delete it. See this function's own doc
 * comment below for why that gap is accepted rather than closed.
 */
export interface RewriteRange {
  /** Keys of every entry that disappears from the timeline, for
   * highlighting — includes `kind: "tool"` entries (導出決定 6-b), which are
   * removed from view but are not messages and so are not counted below. */
  keys: string[];
  /** Deleted message count, target message included. Equals
   * `userCount + bossCount`. */
  total: number;
  userCount: number;
  bossCount: number;
}

/** A fresh empty range per call: the returned value (including its `keys`
 * array) belongs to the caller, so a shared singleton could be corrupted for
 * every later call by one caller mutating it. */
function emptyRange(): RewriteRange {
  return { keys: [], total: 0, userCount: 0, bossCount: 0 };
}

/**
 * Computes what a rewrite starting at `messageId` (in `activeSessionId`)
 * would delete, from the merged timeline `buildTimeline` produces.
 *
 * `entries` is assumed to already be in `buildTimeline`'s order
 * (`created_at`, phase, `id` ascending) — this function does not re-sort. It
 * scans forward from the target entry and, for `kind: "message"` entries,
 * counts only those whose `sessionId === activeSessionId`: the timeline is a
 * merge of every session shown today (Issue #272), so a finished
 * morning/evening meeting can sit between two adhoc messages in screen order
 * without being part of what a rewrite of the adhoc conversation deletes
 * (導出決定 6-a). `kind: "tool"` entries carry no session of their own — they
 * are never persisted and only ever appended live to the session currently
 * streaming, so one can only appear here as part of the active session's own
 * conversation, never spliced in from an unrelated finished meeting; that is
 * why every `kind: "tool"` entry from the target onward is folded into
 * `keys` unconditionally, but excluded from every count. `kind: "boundary"`
 * entries are never touched (AC-28).
 *
 * Returns an empty range when the target message cannot be found (not an
 * expected case in normal use — the entry being edited is by construction
 * already on screen — but a pure function should not throw on a shape it
 * cannot repair; "nothing will be deleted" is also the safe default given
 * this count's job of never over-promising a deletion, 決定 6).
 *
 * A later `kind: "message"` entry with no `messageId`/`sessionId` is skipped
 * by the `entry.sessionId !== activeSessionId` check below, the same as a
 * genuinely different session. As of Issue #378, `useChat` only leaves a
 * `kind: "message"` entry without identifiers for `send`'s own optimistic
 * append (AC-38b — the server hasn't told the client that message's
 * persisted id) or an interrupted-abort entry that landed before `done`;
 * both remain a deliberate, accepted gap in this count (a rewrite reaching
 * back past one of them under-counts it), not something #378 closes.
 * `rewrite` itself never leaves such an entry behind — it rebuilds *every*
 * session in today's view from the server once its request settles
 * (`useChat`'s `refreshTimeline`, the same `loadTimeline` call
 * `startSession`/`endSession` already use), rather than splicing an
 * optimistic entry into `entries` the way `send` does. This function is no
 * longer in `rewrite`'s own execution path at all (Issue #378) — it now
 * exists solely to drive the confirmation UI's preview, computed against
 * `entries` *before* `rewrite` is called. A *completed* boss reply appended
 * outside `buildTimeline` (via `useChat`'s `messageEntry` helper, used by
 * `send`'s `onDone`) always carries real `messageId`/`sessionId` (AC-38c),
 * which is what lets that preview count a rewrite reaching back past a
 * prior turn correctly, without a reload.
 */
export function selectRewriteRange(
  entries: ChatEntry[],
  activeSessionId: number,
  messageId: number,
): RewriteRange {
  const startIndex = entries.findIndex(
    (entry) =>
      entry.kind === "message" &&
      entry.sessionId === activeSessionId &&
      entry.messageId === messageId,
  );

  if (startIndex === -1) {
    return emptyRange();
  }

  const keys: string[] = [];
  let userCount = 0;
  let bossCount = 0;

  for (const entry of entries.slice(startIndex)) {
    if (entry.kind === "boundary") {
      continue;
    }

    if (entry.kind === "tool") {
      keys.push(entry.key);
      continue;
    }

    // entry.kind === "message"
    if (entry.sessionId !== activeSessionId) {
      continue;
    }

    keys.push(entry.key);
    if (entry.role === "user") {
      userCount += 1;
    } else {
      bossCount += 1;
    }
  }

  return { keys, total: userCount + bossCount, userCount, bossCount };
}
