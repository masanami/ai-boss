import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAdhocSession,
  fetchLatestAdhocSession,
  fetchSessionMessages,
  sendChatMessage,
} from "./chat-api";
import type { ChatMessage, ChatToolEvent } from "./chat";

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
  sending: boolean;
  streamingText: string;
  error: string | null;
  send: (content: string) => Promise<void>;
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
 * Chat state for the adhoc conversation with the boss. On mount, restores
 * the history of the latest adhoc session (if any). The session itself is
 * created lazily on the first send, so opening the app never writes to the
 * database.
 */
export function useChat(): UseChatResult {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [status, setStatus] = useState<ChatLoadStatus>("loading");
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<number | null>(null);
  const entryCounterRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const session = await fetchLatestAdhocSession();
      if (session === null) {
        return [] as ChatMessage[];
      }
      const messages = await fetchSessionMessages(session.id);
      if (!cancelled) {
        sessionIdRef.current = session.id;
      }
      return messages;
    })()
      .then((messages) => {
        if (!cancelled) {
          setEntries(messages.map(messageEntry));
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

  const nextLocalKey = useCallback((prefix: string) => {
    entryCounterRef.current += 1;
    return `${prefix}-local-${entryCounterRef.current}`;
  }, []);

  const send = useCallback(
    async (content: string) => {
      if (sending) {
        return;
      }
      setSending(true);
      setError(null);

      try {
        if (sessionIdRef.current === null) {
          const session = await createAdhocSession();
          sessionIdRef.current = session.id;
        }
        const sessionId = sessionIdRef.current;

        setEntries((prev) => [
          ...prev,
          { kind: "message", key: nextLocalKey("user"), role: "user", content },
        ]);

        await sendChatMessage(sessionId, content, {
          onText: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onTool: (tool) => {
            setEntries((prev) => [
              ...prev,
              { kind: "tool", key: nextLocalKey("tool"), tool },
            ]);
          },
          onDone: (message) => {
            setEntries((prev) => [...prev, messageEntry(message)]);
          },
          onError: (message) => {
            setError(message);
          },
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "メッセージの送信に失敗しました",
        );
      } finally {
        setStreamingText("");
        setSending(false);
      }
    },
    [sending, nextLocalKey],
  );

  return { entries, status, sending, streamingText, error, send };
}
