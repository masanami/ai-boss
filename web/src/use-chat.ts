import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  endSession as endSessionRequest,
  fetchLatestSession,
  fetchSessionMessages,
  fetchSessions,
  sendChatMessage,
} from "./chat-api";
import type { ChatMessage, ChatToolEvent, SessionType } from "./chat";
import { isSameLocalDay } from "./is-same-local-day";
import { selectRestoreSessions } from "./select-restore-session";

export type ChatLoadStatus = "loading" | "ready" | "error";

/**
 * A single item in the chat timeline: a persisted/optimistic message or a
 * notice that the boss executed a task tool. `key` is a client-side render
 * key (optimistic user messages have no server id).
 */
export type ChatEntry =
  | { kind: "message"; key: string; role: "user" | "boss"; content: string }
  | { kind: "tool"; key: string; tool: ChatToolEvent };

export interface UseChatResult {
  entries: ChatEntry[];
  status: ChatLoadStatus;
  sessionType: SessionType;
  sending: boolean;
  switching: boolean;
  streamingText: string;
  error: string | null;
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
  startSession: (type: "morning" | "evening") => Promise<void>;
  endSession: () => Promise<void>;
}

/** Snapshot of the adhoc conversation, kept in memory while a morning/evening
 * session is active so ending it can return to exactly where adhoc chat left
 * off without an extra round-trip. */
interface AdhocSnapshot {
  sessionId: number | null;
  entries: ChatEntry[];
}

function messageEntry(message: ChatMessage): ChatEntry {
  return {
    kind: "message",
    key: `message-${message.id}`,
    role: message.role,
    content: message.content,
  };
}

/**
 * Loads the session that should be considered "active" for the given type:
 * today's session of that type if one exists (restoring its history), or
 * `null` history when none exists yet (the caller decides whether to create
 * one immediately or lazily on first send).
 */
async function loadTodaysSession(
  type: SessionType,
): Promise<{ session: { id: number } | null; messages: ChatMessage[] }> {
  const session = await fetchLatestSession(type);
  if (session === null || !isSameLocalDay(new Date(), new Date(session.started_at))) {
    return { session: null, messages: [] };
  }
  const messages = await fetchSessionMessages(session.id);
  return { session, messages };
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
 * having none: it is never restored as active or as the return point below
 * (Issue #206).
 *
 * When a morning/evening session is restored as active, today's unfinished
 * adhoc session (if any) is also fetched and kept in `adhocSnapshotRef` so
 * ending the restored meeting can return to the adhoc conversation without
 * an extra round-trip, exactly like `startSession` already does.
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
  const sessionIdRef = useRef<number | null>(null);
  const sessionTypeRef = useRef<SessionType>("adhoc");
  const entriesRef = useRef<ChatEntry[]>([]);
  const adhocSnapshotRef = useRef<AdhocSnapshot | null>(null);
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

    fetchSessions()
      .then(async (sessions) => {
        const { active, adhoc } = selectRestoreSessions(sessions, new Date());

        if (active !== null && active.type !== "adhoc") {
          // An unfinished morning/evening session takes priority: restore it
          // as active, and separately restore today's adhoc conversation (if
          // any) into the snapshot so `endSession` has somewhere to return.
          const [activeMessages, adhocMessages] = await Promise.all([
            fetchSessionMessages(active.id),
            adhoc !== null ? fetchSessionMessages(adhoc.id) : Promise.resolve([]),
          ]);
          if (cancelled) {
            return;
          }
          sessionIdRef.current = active.id;
          adhocSnapshotRef.current = {
            sessionId: adhoc?.id ?? null,
            entries: adhocMessages.map(messageEntry),
          };
          setSessionType(active.type);
          setEntries(activeMessages.map(messageEntry));
          setStatus("ready");
          return;
        }

        // No open meeting today: fall back to restoring the adhoc
        // conversation, exactly like before this feature (adhocSnapshotRef
        // stays null, matching the "started fresh in adhoc" state).
        const messages =
          active !== null ? await fetchSessionMessages(active.id) : [];
        if (cancelled) {
          return;
        }
        sessionIdRef.current = active?.id ?? null;
        setEntries(messages.map(messageEntry));
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
  }, []);

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
          sessionIdRef.current = session.id;
        }
        const sessionId = sessionIdRef.current;
        if (sessionId === null) {
          throw new Error("session id must be set before sending");
        }

        await sendChatMessage(sessionId, content, {
          onText: (delta) => {
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
            ifMounted(() => setEntries((prev) => [...prev, messageEntry(message)]));
          },
          onError: (message) => {
            ifMounted(() => setError(message));
          },
        });
      } catch (err) {
        ifMounted(() =>
          setError(
            err instanceof Error
              ? err.message
              : "メッセージの送信に失敗しました",
          ),
        );
      } finally {
        sendingRef.current = false;
        ifMounted(() => {
          setStreamingText("");
          setSending(false);
        });
      }
    },
    [ifMounted, nextLocalKey],
  );

  const startSession = useCallback(
    async (type: "morning" | "evening") => {
      // Only reachable from adhoc in the UI (start buttons only render there),
      // but guarded here too: starting from a non-adhoc session would
      // overwrite the adhoc snapshot with the wrong conversation.
      if (switchingRef.current || sendingRef.current || sessionTypeRef.current !== "adhoc") {
        return;
      }
      switchingRef.current = true;
      setSwitching(true);
      setError(null);
      try {
        // Remember exactly where the adhoc conversation was so ending this
        // session can restore it without a re-fetch.
        adhocSnapshotRef.current = {
          sessionId: sessionIdRef.current,
          entries: entriesRef.current,
        };

        const { session, messages } = await loadTodaysSession(type);
        const isNewSession = session === null;
        const active = session ?? (await createSession(type));
        // Issue #271: `POST /api/sessions` may have generated a "meeting
        // opening" boss message as a synchronous side effect (best-effort —
        // morning/evening only). `loadTodaysSession`'s `messages` is always
        // [] for a brand-new session (it only reads history for an
        // *existing* one, above), so that line — if any — has to be
        // fetched separately here rather than assumed absent. Skipped when
        // an existing session was resumed instead: its history (including
        // any past opening line) is already in `messages`.
        const activeMessages = isNewSession
          ? await fetchSessionMessages(active.id)
          : messages;

        sessionIdRef.current = active.id;
        ifMounted(() => {
          setSessionType(type);
          setEntries(activeMessages.map(messageEntry));
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
    [ifMounted],
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

      const snapshot = adhocSnapshotRef.current;
      adhocSnapshotRef.current = null;
      sessionIdRef.current = snapshot?.sessionId ?? null;
      ifMounted(() => {
        setSessionType("adhoc");
        setEntries(snapshot?.entries ?? []);
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
  }, [ifMounted]);

  return {
    entries,
    status,
    sessionType,
    sending,
    switching,
    streamingText,
    error,
    draft,
    setDraft,
    send,
    startSession,
    endSession,
  };
}
