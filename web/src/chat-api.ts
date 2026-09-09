import type {
  ChatMessage,
  ChatSession,
  ChatStreamHandlers,
  ChatToolEvent,
  SessionType,
} from "./chat";

const SESSIONS_URL = "/api/sessions";

/**
 * Thrown by every chat API client function on a non-ok response. Mirrors
 * `daily-reports-api.ts`'s `ReportApiError`: the UI must branch on the
 * stable `code` the backend attaches (e.g. `mentoring_required` on a blocked
 * `POST /:id/end`, ADR 0008 決定2 と同じ作法), not on the Japanese message
 * text, so this error keeps `code` alongside `message`. `code` is
 * `undefined` when the server didn't provide one (e.g. an unexpected 500).
 */
export class ChatApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "ChatApiError";
    this.code = code;
  }
}

async function toChatApiError(response: Response): Promise<ChatApiError> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return new ChatApiError(
      body.error ?? `request failed with status ${response.status}`,
      body.code,
    );
  } catch {
    return new ChatApiError(
      `request failed with status ${response.status}`,
      undefined,
    );
  }
}

/**
 * Returns the most recent session of the given type, or null when none
 * exists yet. The backend lists sessions newest-first, so the first element
 * is the latest.
 */
export async function fetchLatestSession(
  type: SessionType,
): Promise<ChatSession | null> {
  const response = await fetch(`${SESSIONS_URL}?type=${type}`);
  if (!response.ok) {
    throw await toChatApiError(response);
  }
  const sessions = (await response.json()) as ChatSession[];
  return sessions[0] ?? null;
}

/**
 * Returns all sessions (any type), newest-first, as reported by the
 * unfiltered `/api/sessions` endpoint. Used on mount to find today's open
 * morning/evening session in a single round-trip instead of querying each
 * type separately.
 */
export async function fetchSessions(): Promise<ChatSession[]> {
  const response = await fetch(SESSIONS_URL);
  if (!response.ok) {
    throw await toChatApiError(response);
  }
  return (await response.json()) as ChatSession[];
}

export async function createSession(type: SessionType): Promise<ChatSession> {
  const response = await fetch(SESSIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
  if (!response.ok) {
    throw await toChatApiError(response);
  }
  return (await response.json()) as ChatSession;
}

/**
 * Ends the given session (sets `ended_at`) and returns the updated record.
 */
export async function endSession(sessionId: number): Promise<ChatSession> {
  const response = await fetch(`${SESSIONS_URL}/${sessionId}/end`, {
    method: "POST",
  });
  if (!response.ok) {
    throw await toChatApiError(response);
  }
  return (await response.json()) as ChatSession;
}

export async function fetchSessionMessages(
  sessionId: number,
): Promise<ChatMessage[]> {
  const response = await fetch(`${SESSIONS_URL}/${sessionId}/messages`);
  if (!response.ok) {
    throw await toChatApiError(response);
  }
  return (await response.json()) as ChatMessage[];
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseBlock(block: string): SseEvent {
  const lines = block.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return {
    event: eventLine ? eventLine.slice("event: ".length) : "message",
    data,
  };
}

function dispatchSseEvent(event: SseEvent, handlers: ChatStreamHandlers): void {
  switch (event.event) {
    case "text": {
      const payload = JSON.parse(event.data) as { text: string };
      handlers.onText(payload.text);
      return;
    }
    case "tool": {
      handlers.onTool(JSON.parse(event.data) as ChatToolEvent);
      return;
    }
    case "done": {
      handlers.onDone(JSON.parse(event.data) as ChatMessage);
      return;
    }
    case "error": {
      const payload = JSON.parse(event.data) as { error: string };
      handlers.onError(payload.error);
      return;
    }
    default:
      // Unknown events are ignored so the server can add event types
      // without breaking older clients.
      return;
  }
}

/**
 * Sends a chat message and consumes the boss response as an SSE stream,
 * dispatching each event to the given handlers. `EventSource` cannot send a
 * POST body, so the stream is read manually from `fetch`'s response body.
 * Resolves once the stream has ended; rejects only when the request itself
 * fails before streaming starts (e.g. 400/404/500 JSON responses).
 *
 * `signal` aborts the request (Issue #254). Hanging up is the whole stop
 * protocol — there is no stop endpoint — so aborting here is also what makes
 * the server abandon its LLM call. The rejection that follows is a plain
 * `AbortError` from `fetch`; callers are expected to recognize it as "the
 * user stopped this" rather than surfacing it as a failure.
 *
 * `replaceFromMessageId` requests a rewrite (Issue #378, #255 決定6): the
 * server truncates the session from that message onward before generating
 * the new reply. Omitted, the POST body is `{ content }` unchanged — this
 * keeps the existing contract for a plain send untouched.
 *
 * `mentoring` requests the 随時メンタリング flow (Issue #411, 親 #276 判断6):
 * `true` adds `mentoring: true` to the body, which makes the server queue
 * `MENTORING_FLOW_INSTRUCTION` for this turn regardless of the session type
 * or the 強制 setting (`sessions-validation.ts`'s `ChatMessageInput`).
 * Mirrors the server's undefined-as-absent contract — omitted or `false`
 * leaves the body without a `mentoring` key at all, same as
 * `replaceFromMessageId`.
 */
export async function sendChatMessage(
  sessionId: number,
  content: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  replaceFromMessageId?: number,
  mentoring?: boolean,
): Promise<void> {
  const body: {
    content: string;
    replaceFromMessageId?: number;
    mentoring?: true;
  } = { content };
  if (replaceFromMessageId !== undefined) {
    body.replaceFromMessageId = replaceFromMessageId;
  }
  if (mentoring === true) {
    body.mentoring = true;
  }
  const response = await fetch(`${SESSIONS_URL}/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw await toChatApiError(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (block.trim().length > 0) {
        try {
          dispatchSseEvent(parseSseBlock(block), handlers);
        } catch {
          // Once streaming has started, failures are reported through
          // onError instead of a rejection (see the doc comment above).
          // Malformed event data leaves the rest of the stream untrusted,
          // so stop reading instead of dispatching further events.
          handlers.onError("ボスの応答データを解釈できませんでした");
          await reader.cancel();
          return;
        }
      }
      separatorIndex = buffer.indexOf("\n\n");
    }
  }
}
