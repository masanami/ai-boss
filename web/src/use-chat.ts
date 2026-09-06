import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  endSession as endSessionRequest,
  fetchSessionMessages,
  fetchSessions,
  sendChatMessage,
} from "./chat-api";
import type { ChatEntry, ChatMessage, ChatSession, SessionType } from "./chat";
import { selectRestoreSessions } from "./select-restore-session";
import { buildTimeline, selectTimelineSessions } from "./merge-timeline";

export type ChatLoadStatus = "loading" | "ready" | "error";

export type { ChatEntry };

export interface UseChatResult {
  entries: ChatEntry[];
  status: ChatLoadStatus;
  sessionType: SessionType;
  sending: boolean;
  switching: boolean;
  streamingText: string;
  error: string | null;
  /**
   * The id of the session `send`/`rewrite` post to, or `null` before any
   * session exists yet (Issue #378, AC-31). Mirrors the internal
   * `sessionIdRef` as public state — kept in sync everywhere that ref is
   * written (mount restore, lazy creation on first send, `startSession`,
   * `endSession`) — so callers (the rewrite confirmation UI, via
   * `selectRewriteRange`) can scope a rewrite to the session actually being
   * sent to, matching `send`'s own destination.
   */
  activeSessionId: number | null;
  /**
   * The in-progress message text. Lifted up from `ChatView` (Issue #153,
   * same pattern as the rest of this hook's state, Issue #93) so it survives
   * `ChatView` unmounting on a tab switch. Not persisted beyond the page
   * session (no localStorage) — YAGNI. Trade-off: because this hook is held
   * by `AppLayout` (not `ChatView`), every keystroke now re-renders
   * `AppLayout`'s subtree (nav, side panel) in addition to `ChatView` itself
   * — accepted like the other state already lifted here (Issue #93), since
   * this is a small, local, single-user app.
   */
  draft: string;
  setDraft: (value: string) => void;
  send: (content: string) => Promise<void>;
  /**
   * Rewrites a past message (Issue #378, #255 決定6): the server truncates
   * `activeSessionId` from `messageId` onward, then generates a fresh reply
   * to `content` as the new message at that point. No-op while `sending` or
   * `switching` is true (AC-37, same guard `send` uses — the two send
   * paths must not overlap) or while `activeSessionId` is `null` (nothing to
   * rewrite into).
   *
   * Unlike `send`'s optimistic-append-then-reconcile shape, `rewrite` does
   * not splice `entries` locally — it re-fetches every session in today's
   * view and rebuilds the whole displayed timeline from the server
   * (`startSession`/`endSession`'s own `loadTimeline` pattern) once the
   * request settles, on *every* exit path (success, a mid-stream `error`
   * event, a stop, or any other failure), so every resulting entry carries
   * real `messageId`/`sessionId` values the same way a reload would
   * (AC-33/AC-34/AC-35/AC-38c/AC-54). See the comment above
   * `refreshTimeline` in the implementation for why this also covers AC-36:
   * refreshing even when nothing changed server-side just redraws the same
   * state, so a genuinely-untouched timeline still reads as unchanged.
   */
  rewrite: (messageId: number, content: string) => Promise<void>;
  /**
   * Cuts the in-flight boss reply short (Issue #254). No-op when nothing is
   * being generated, so callers (a stop button, an ESC handler) can fire it
   * without checking first.
   *
   * Aborting the request is the entire stop protocol: it hangs up on the
   * server, which is what makes it abandon its LLM call. Whatever text had
   * already arrived stays on screen as an interrupted reply — the server
   * persists the same text on its side, so a reload shows the same thing.
   */
  stop: () => void;
  startSession: (type: "morning" | "evening") => Promise<void>;
  endSession: () => Promise<void>;
}

/** Appends a just-persisted message to the timeline without a full rebuild.
 * Uses the same `message-{id}` key `buildTimeline` produces, so the entry is
 * stable across the next rebuild.
 *
 * Sets `messageId`/`sessionId` from the persisted message (Issue #378,
 * AC-38c): this is the entry `onDone` appends outside `buildTimeline`, and
 * without these identifiers a rewrite issued later in the same session
 * (without a reload) would under-count what `selectRewriteRange` says it
 * will delete — the confirmation UI's count and highlighting are the only
 * safeguard before an irreversible truncation (決定 6), so a half-built
 * entry here silently breaks it. */
function messageEntry(message: ChatMessage): ChatEntry {
  return {
    kind: "message",
    key: `message-${message.id}`,
    role: message.role,
    content: message.content,
    messageId: message.id,
    sessionId: message.session_id,
  };
}

/**
 * Rebuilds the unified timeline (Issue #272 判断5・判断6): every session that
 * belongs in today's view, merged into one `created_at`-ascending list with
 * derived meeting boundaries.
 *
 * `pinnedSessionIds` is passed through to `selectTimelineSessions` so a
 * meeting that started before midnight stays visible across the day boundary
 * (ADR 0007 決定4 attributes it to its start day).
 *
 * Replaces the previous `adhocSnapshotRef` save/restore dance: the timeline
 * no longer swaps out when a meeting starts or ends, so there is nothing to
 * snapshot — the server is the single source of truth for what to show.
 */
async function loadTimeline(
  sessions: ChatSession[],
  now: Date,
  pinnedSessionIds: readonly (number | null)[],
): Promise<ChatEntry[]> {
  const selected = selectTimelineSessions(sessions, now, pinnedSessionIds);
  const loaded = await Promise.all(
    selected.map(async (session) => ({
      session,
      messages: await fetchSessionMessages(session.id),
    })),
  );
  return buildTimeline(loaded);
}

/** Replaces `session` in `sessions` by id, appending it when it isn't there
 * yet. Lets `startSession`/`endSession` fold a just-created or just-ended
 * session into the list they already fetched, instead of paying for a second
 * `GET /api/sessions` round-trip to observe their own write. */
function withSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [...sessions, session];
  }
  return sessions.map((candidate) =>
    candidate.id === session.id ? session : candidate,
  );
}

/**
 * Finds today's *unfinished* session of the given type, or `null` when none
 * exists yet (the caller decides whether to create one immediately or lazily
 * on first send). Only the session is returned — its messages arrive through
 * `loadTimeline`, which rebuilds the whole timeline rather than just this
 * session's slice.
 *
 * The `ended_at === null` filter mirrors `selectRestoreSessions`'s meeting
 * branch, and closing it here is Issue #220: a meeting the user already
 * ended must not be re-adopted as the active session. Without it, every
 * later message is stored in that closed session — and since the server has
 * no guard of its own against posting to an ended session, the merged
 * timeline would render those messages *after* the meeting's own closing
 * boundary (`merge-timeline.ts`'s PHASE_END ordering).
 *
 * For `evening` this means `startSession` falls through to `createSession`,
 * where the server's existing one-evening-per-day rule answers 409
 * (`evening_session_already_exists`) and the caller surfaces that message.
 * Showing the day's evening meeting as already over is the honest outcome;
 * silently writing into the closed session is not.
 */
function findTodaysSession(
  sessions: ChatSession[],
  type: SessionType,
  now: Date,
): ChatSession | null {
  return (
    selectTimelineSessions(sessions, now, []).find(
      (session) => session.type === type && session.ended_at === null,
    ) ?? null
  );
}

/**
 * Chat state for the conversation with the boss, covering the adhoc
 * conversation plus morning/evening sessions.
 *
 * On mount, restores today's (local day) session that should be considered
 * "active": an unfinished morning/evening session if one is open, otherwise
 * today's unfinished adhoc session. This is what lets a morning/evening
 * conversation survive a tab switch (Issue #93 lifts this hook up to
 * `AppLayout` so it is not remounted when the chat tab is left) or a page
 * reload. A session from a previous day is left alone either way — adhoc
 * chat is scoped to a daily window, so a stale one is created lazily on the
 * first send instead. An already-ended adhoc session is treated the same as
 * having none: it is never restored as active (Issue #206).
 *
 * **The displayed timeline is independent of which session is active**
 * (Issue #272): it always shows every session that belongs in today's view,
 * merged into one chronological list with meeting boundaries derived from
 * `sessions.started_at` / `ended_at`. Starting or ending a meeting therefore
 * changes where messages are *sent* and what the session bar shows, but never
 * swaps the history out — which is why the old `adhocSnapshotRef` save/restore
 * is gone.
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ChatLoadStatus>("loading");
  const [sessionType, setSessionType] = useState<SessionType>("adhoc");
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(
    null,
  );
  const sessionIdRef = useRef<number | null>(null);
  const sessionTypeRef = useRef<SessionType>("adhoc");
  const entriesRef = useRef<ChatEntry[]>([]);
  const entryCounterRef = useRef(0);
  // Ref-based guards: unlike the `sending`/`switching` state (which update
  // asynchronously), these refs flip synchronously, so two calls in the same
  // tick cannot both pass the check. `send` and session switching
  // (`startSession`/`endSession`) are also mutually exclusive: sending while
  // switching (or vice versa) could apply an optimistic message or a
  // restored history to the wrong session.
  const sendingRef = useRef(false);
  const switchingRef = useRef(false);
  const mountedRef = useRef(true);
  // Controller for the send currently in flight, or null when nothing is
  // being generated (Issue #254). `stop` aborts through this; `send` clears
  // it on the way out so a later `stop` can't abort a finished request.
  const abortRef = useRef<AbortController | null>(null);

  // Writes both the ref (read synchronously by `send`/`rewrite`/`endSession`
  // in the same tick they run) and the public `activeSessionId` state
  // (AC-31), so the two never drift apart. Every site that used to write
  // `sessionIdRef.current` directly goes through this instead.
  const setActiveSession = useCallback((id: number | null) => {
    sessionIdRef.current = id;
    setActiveSessionIdState(id);
  }, []);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    sessionTypeRef.current = sessionType;
  }, [sessionType]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // After unmount, async callbacks (streaming, session switching) must not
  // touch state anymore (same idea as the `cancelled` flag in the mount
  // effect). Shared by `send` / `startSession` / `endSession`.
  const ifMounted = useCallback((update: () => void) => {
    if (mountedRef.current) {
      update();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const now = new Date();
    fetchSessions()
      .then(async (sessions) => {
        // Which session is "active" (where sends go, what the session bar
        // shows) is still decided by `selectRestoreSessions` — an unfinished
        // meeting wins over today's adhoc conversation. What changed in
        // Issue #272 is that this no longer decides what is *displayed*.
        const { active } = selectRestoreSessions(sessions, now);
        const timeline = await loadTimeline(sessions, now, [active?.id ?? null]);
        if (cancelled) {
          return;
        }
        setActiveSession(active?.id ?? null);
        if (active !== null && active.type !== "adhoc") {
          setSessionType(active.type);
        }
        setEntries(timeline);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setActiveSession]);

  const nextLocalKey = useCallback((prefix: string) => {
    entryCounterRef.current += 1;
    return `${prefix}-local-${entryCounterRef.current}`;
  }, []);

  const send = useCallback(
    async (content: string) => {
      if (sendingRef.current || switchingRef.current) {
        return;
      }
      sendingRef.current = true;
      setSending(true);
      setError(null);

      const controller = new AbortController();
      // Mirrors `setStreamingText`, but readable synchronously from the
      // catch below — state read there would be the stale value captured
      // when this callback was created. Same role the server's `fullText`
      // plays: "what actually reached the user before this stopped".
      let deliveredText = "";
      // Set once the `done` event has been handled, i.e. the complete reply
      // has already been appended to the timeline. `sendChatMessage` keeps
      // reading until EOF after dispatching `done`, so there is a window in
      // which the reply is finished but a stop can still abort that pending
      // read — see the catch below.
      let completed = false;

      // Optimistic append BEFORE any request: the input field is already
      // cleared by the caller (ChatView's submitDraft, via chatState.setDraft
      // below), so even a session-creation failure must not lose what the
      // user typed.
      setEntries((prev) => [
        ...prev,
        { kind: "message", key: nextLocalKey("user"), role: "user", content },
      ]);

      try {
        if (sessionIdRef.current === null) {
          const session = await createSession("adhoc");
          setActiveSession(session.id);
        }
        const sessionId = sessionIdRef.current;
        if (sessionId === null) {
          throw new Error("session id must be set before sending");
        }

        // Only stoppable from here on, once the message POST is about to be
        // dispatched (#254, Codex review on PR #287).
        //
        // Arming this before `createSession` above meant a stop pressed
        // during session creation left `controller.signal` already aborted,
        // so `sendChatMessage`'s `fetch` rejected without ever posting —
        // the user's message never reached the server. The optimistic entry
        // kept it on screen, which hid the problem until a reload, and
        // "ユーザーの発言は履歴に残る" is a completion condition of #254.
        //
        // A stop pressed before this point is therefore deliberately not
        // honored: nothing is being generated yet, and the only way to honor
        // it there would be to drop the user's message on the floor.
        // Generation starts moments later and stops normally.
        abortRef.current = controller;

        await sendChatMessage(
          sessionId,
          content,
          {
          onText: (delta) => {
            deliveredText += delta;
            ifMounted(() => setStreamingText((prev) => prev + delta));
          },
          onTool: (tool) => {
            ifMounted(() =>
              setEntries((prev) => [
                ...prev,
                { kind: "tool", key: nextLocalKey("tool"), tool },
              ]),
            );
          },
          onDone: (message) => {
            completed = true;
            ifMounted(() => setEntries((prev) => [...prev, messageEntry(message)]));
          },
          onError: (message) => {
            ifMounted(() => setError(message));
          },
          },
          controller.signal,
        );
      } catch (err) {
        // Keyed on our own controller rather than on the error's name: this
        // is the one thing that says for certain the rejection came from
        // `stop` and not from a network failure that happens to look like
        // one.
        if (controller.signal.aborted) {
          // A stop is not an error — no error banner (AC-23). What the user
          // did see stays on screen, marked as cut short, matching the
          // partial reply the server persisted for the same send.
          //
          // 完了が勝つ (#254 論点5), on the client too: `done` may already
          // have been dispatched while `sendChatMessage` was still reading
          // toward EOF, and a stop landing in that window aborts the pending
          // read. The reply is whole and `onDone` has already appended it —
          // appending `deliveredText` as well would show the same answer
          // twice, the second copy falsely marked as cut short. The server
          // resolves the identical race the same way (`chat-messages-route`
          // persists `interrupted: 0` once the generation resolved).
          if (!completed && deliveredText !== "") {
            ifMounted(() =>
              setEntries((prev) => [
                ...prev,
                {
                  kind: "message",
                  key: nextLocalKey("boss"),
                  role: "boss",
                  content: deliveredText,
                  interrupted: true,
                },
              ]),
            );
          }
        } else {
          ifMounted(() =>
            setError(
              err instanceof Error
                ? err.message
                : "メッセージの送信に失敗しました",
            ),
          );
        }
      } finally {
        sendingRef.current = false;
        abortRef.current = null;
        ifMounted(() => {
          setStreamingText("");
          setSending(false);
        });
      }
    },
    [ifMounted, nextLocalKey, setActiveSession],
  );

  const rewrite = useCallback(
    async (messageId: number, content: string) => {
      // Same mutual-exclusion guard as `send` (AC-37): the two send paths
      // must not be open at the same time, or a rebuild from one could land
      // on top of the other's in-flight state.
      if (sendingRef.current || switchingRef.current) {
        return;
      }
      const sessionId = sessionIdRef.current;
      // Nothing to rewrite into (mirrors `activeSessionId` being null) — a
      // silent no-op, like `stop` is when nothing is generating.
      if (sessionId === null) {
        return;
      }

      sendingRef.current = true;
      setSending(true);
      setError(null);

      const controller = new AbortController();
      // Armed synchronously, right before the request goes out — unlike
      // `send`, there is no session-creation await beforehand to leave a gap
      // where a stop could land before anything is dispatched.
      abortRef.current = controller;

      // Rebuilds the *whole* displayed timeline from the server (every
      // session in today's view, same as `startSession`/`endSession`'s own
      // `loadTimeline` call — not just `activeSessionId`'s messages) instead
      // of splicing `entries` locally (unlike `send`'s
      // optimistic-append-then-reconcile shape). `chat-messages-route.ts`
      // runs the truncation-plus-insert transaction *before* it starts
      // streaming a reply, so by the time `sendChatMessage`'s promise
      // settles at all — success, a mid-stream `error` event, a stop, or a
      // transport failure once streaming has already begun — the deletion
      // has already either happened or never will, and a local guess based
      // on which callback fired, or on `controller.signal.aborted`, cannot
      // say which: a rejection can land either before or after the
      // server-side commit, and the two look identical from here (`stop`
      // pressed after the commit vs. a network drop after the commit vs. a
      // guard rejecting *before* any commit all surface as the same "the
      // promise rejected" shape). Calling this unconditionally on every exit
      // path below, rather than only on success, is what actually closes
      // that gap — a rewrite whose commit is uncertain to the client must
      // never leave the screen showing pre-commit state. A no-op refresh
      // (nothing actually changed server-side) is safe too: it just redraws
      // the same state that was already on screen, satisfying AC-36 by
      // outcome rather than by skipping the fetch. This also gives every
      // entry real `messageId`/`sessionId` values for free, via
      // `buildTimeline` (AC-38/AC-38c) — including the rewritten user
      // message itself, which a local splice could never identify (the
      // server never tells the client that message's persisted id; only the
      // boss reply comes back, in the `done` event).
      //
      // Wrapped in its own try/catch so a failure here (a second network
      // failure landing in this narrow window) cannot throw out of
      // `rewrite` uncaught, nor mask whatever error message the caller below
      // is about to show — the alternative (surfacing a distinct "refresh
      // failed" message) would ask the user to reason about a rare
      // double-failure; leaving `entries` exactly as they were and letting a
      // manual reload be the recovery path is the simpler, honest fallback.
      const refreshTimeline = async () => {
        try {
          const now = new Date();
          const sessions = await fetchSessions();
          const timeline = await loadTimeline(sessions, now, [sessionId]);
          ifMounted(() => setEntries(timeline));
        } catch {
          // Best-effort only — see the comment above.
        }
      };

      try {
        await sendChatMessage(
          sessionId,
          content,
          {
            onText: (delta) => {
              ifMounted(() => setStreamingText((prev) => prev + delta));
            },
            onTool: (tool) => {
              // Live feedback only, during generation — the whole timeline
              // is rebuilt from the server once the stream settles (below),
              // so this entry never has to be the final state and does not
              // need a `range`-derived removal the way a local splice would.
              ifMounted(() =>
                setEntries((prev) => [
                  ...prev,
                  { kind: "tool", key: nextLocalKey("tool"), tool },
                ]),
              );
            },
            onDone: () => {
              // Nothing to do with the boss message here: `refreshTimeline`
              // below reconstructs the same entry (and everything else)
              // straight from the server.
            },
            onError: (message) => {
              // `error` is an SSE event dispatched mid-stream, not a
              // rejection — `sendChatMessage`'s promise still resolves
              // normally afterwards, so `refreshTimeline` below still runs
              // and shows whatever the server actually committed (which may
              // include a partial, `interrupted` boss reply) alongside this
              // message.
              ifMounted(() => setError(message));
            },
          },
          controller.signal,
          messageId,
        );
        await refreshTimeline();
      } catch (err) {
        // Always refresh, regardless of `controller.signal.aborted` — see
        // the comment above `refreshTimeline` for why that flag cannot
        // distinguish "nothing changed" from "the commit already happened".
        await refreshTimeline();
        if (!controller.signal.aborted) {
          // A stop is not an error (same idea as `send`'s AC-23) — no error
          // banner for it, even though the refresh above still ran.
          ifMounted(() =>
            setError(
              err instanceof Error ? err.message : "書き直しに失敗しました",
            ),
          );
        }
      } finally {
        sendingRef.current = false;
        abortRef.current = null;
        ifMounted(() => {
          setStreamingText("");
          setSending(false);
        });
      }
    },
    [ifMounted, nextLocalKey],
  );

  const stop = useCallback(() => {
    // No-op when nothing is in flight (`abortRef` is null), so a stop button
    // or an ESC handler can call this unconditionally.
    abortRef.current?.abort();
  }, []);

  const startSession = useCallback(
    async (type: "morning" | "evening") => {
      // Only reachable from adhoc in the UI (start buttons only render
      // there), but guarded here too so a meeting cannot be started from
      // inside another one.
      if (switchingRef.current || sendingRef.current || sessionTypeRef.current !== "adhoc") {
        return;
      }
      switchingRef.current = true;
      setSwitching(true);
      setError(null);
      try {
        const now = new Date();
        const sessions = await fetchSessions();
        const existing = findTodaysSession(sessions, type, now);
        const active = existing ?? (await createSession(type));

        // Rebuild the whole timeline rather than swapping in this session's
        // messages: the adhoc conversation the user was just having stays on
        // screen above the new meeting's start boundary (AC-9). This is also
        // what surfaces the Issue #271 meeting-opening line, which
        // `POST /api/sessions` may have just generated as a synchronous side
        // effect.
        const timeline = await loadTimeline(
          withSession(sessions, active),
          now,
          [active.id],
        );

        setActiveSession(active.id);
        ifMounted(() => {
          setSessionType(type);
          setEntries(timeline);
        });
      } catch (err) {
        ifMounted(() =>
          setError(
            err instanceof Error ? err.message : "セッションの開始に失敗しました",
          ),
        );
      } finally {
        switchingRef.current = false;
        ifMounted(() => setSwitching(false));
      }
    },
    [ifMounted, setActiveSession],
  );

  const endSession = useCallback(async () => {
    if (switchingRef.current || sendingRef.current) {
      return;
    }
    const id = sessionIdRef.current;
    if (id === null) {
      return;
    }
    switchingRef.current = true;
    setSwitching(true);
    setError(null);
    try {
      await endSessionRequest(id);

      // Sends go back to the adhoc conversation, but the meeting's messages
      // stay on screen between its boundaries (AC-10) — the timeline is
      // rebuilt from the server, not restored from a snapshot. `null` when
      // no adhoc session exists yet: `send` creates one lazily.
      //
      // The session list is fetched *after* the end request, so it already
      // carries the `ended_at` that turns into the closing boundary.
      const now = new Date();
      const sessions = await fetchSessions();
      const { adhoc } = selectRestoreSessions(sessions, now);
      // `id` (the meeting just ended) is pinned alongside the adhoc session:
      // ending a meeting on the far side of midnight must not make it vanish
      // from the screen the moment it closes (ADR 0007 決定4 attributes it to
      // its start day, which is now "yesterday").
      const timeline = await loadTimeline(sessions, now, [id, adhoc?.id ?? null]);

      setActiveSession(adhoc?.id ?? null);
      ifMounted(() => {
        setSessionType("adhoc");
        setEntries(timeline);
      });
    } catch (err) {
      ifMounted(() =>
        setError(
          err instanceof Error ? err.message : "セッションの終了に失敗しました",
        ),
      );
    } finally {
      switchingRef.current = false;
      ifMounted(() => setSwitching(false));
    }
  }, [ifMounted, setActiveSession]);

  return {
    entries,
    status,
    sessionType,
    sending,
    switching,
    streamingText,
    error,
    activeSessionId,
    draft,
    setDraft,
    send,
    rewrite,
    stop,
    startSession,
    endSession,
  };
}
