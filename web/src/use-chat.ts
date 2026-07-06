import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSession,
  endSession as endSessionRequest,
  fetchLatestSession,
  fetchSessionMessages,
  sendChatMessage,
} from "./chat-api";
import type { ChatMessage, ChatToolEvent, SessionType } from "./chat";
import { isSameLocalDay } from "./is-same-local-day";

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
 * On mount, restores the history of the latest adhoc session, but only if it
 * was started today (local day) — adhoc chat is scoped to a daily window, so
 * a session from a previous day is left alone and a fresh one is created
 * lazily on the first send instead.
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ChatLoadStatus>("loading");
  const [sessionType, setSessionType] = useState<SessionType>("adhoc");
  const [sending, setSending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;

    loadTodaysSession("adhoc")
      .then(({ session, messages }) => {
        if (cancelled) {
          return;
        }
        sessionIdRef.current = session?.id ?? null;
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
      // cleared by the caller, so even a session-creation failure must not
      // lose what the user typed.
      setEntries((prev) => [
        ...prev,
        { kind: "message", key: nextLocalKey("user"), role: "user", content },
      ]);

      // After unmount, streaming callbacks must not touch state anymore
      // (same idea as the `cancelled` flag in the mount effect).
      const ifMounted = (update: () => void) => {
        if (mountedRef.current) {
          update();
        }
      };

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
    [nextLocalKey],
  );

  const startSession = useCallback(async (type: "morning" | "evening") => {
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
      const active = session ?? (await createSession(type));

      sessionIdRef.current = active.id;
      setSessionType(type);
      setEntries(messages.map(messageEntry));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "セッションの開始に失敗しました",
      );
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, []);

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
      setSessionType("adhoc");
      setEntries(snapshot?.entries ?? []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "セッションの終了に失敗しました",
      );
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }, []);

  return {
    entries,
    status,
    sessionType,
    sending,
    switching,
    streamingText,
    error,
    send,
    startSession,
    endSession,
  };
}
