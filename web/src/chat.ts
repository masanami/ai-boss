export type ChatRole = "user" | "boss";

export type SessionType = "morning" | "evening" | "adhoc";

export interface ChatSession {
  id: number;
  type: SessionType;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  role: ChatRole;
  content: string;
  created_at: string;
}

/** Payload of a `tool` SSE event: the boss executed a task tool. */
export interface ChatToolEvent {
  name: string;
  input: unknown;
  result: string;
  isError: boolean;
}

/**
 * A single item in the chat timeline: a persisted/optimistic message, a
 * notice that the boss executed a task tool, or a meeting boundary.
 * `key` is a client-side render key (optimistic user messages have no
 * server id).
 *
 * Boundaries are **derived from `sessions.started_at` / `ended_at`**, not
 * persisted (Issue #272 判断5 — ADR 0005 決定6「算出できるものは保存しない」).
 * They are rendered as non-message elements, following the `kind: "tool"`
 * precedent.
 */
export type ChatEntry =
  | { kind: "message"; key: string; role: ChatRole; content: string }
  | { kind: "tool"; key: string; tool: ChatToolEvent }
  | {
      kind: "boundary";
      key: string;
      sessionType: MeetingSessionType;
      event: "start" | "end";
    };

/** Session types that have an explicit start/end the user drives, and so get
 * a boundary in the timeline. `adhoc` is the "not in a meeting" stretch
 * between them and never gets one (明示的な仮定4). */
export type MeetingSessionType = Exclude<SessionType, "adhoc">;

/** Callbacks invoked while streaming a boss response over SSE. */
export interface ChatStreamHandlers {
  onText: (delta: string) => void;
  onTool: (event: ChatToolEvent) => void;
  onDone: (message: ChatMessage) => void;
  onError: (message: string) => void;
}
