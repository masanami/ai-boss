export type ChatRole = "user" | "boss";

export interface ChatSession {
  id: number;
  type: "morning" | "evening" | "adhoc";
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

/** Callbacks invoked while streaming a boss response over SSE. */
export interface ChatStreamHandlers {
  onText: (delta: string) => void;
  onTool: (event: ChatToolEvent) => void;
  onDone: (message: ChatMessage) => void;
  onError: (message: string) => void;
}
