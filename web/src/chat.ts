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
  /**
   * `0` = 完結した応答 / `1` = 途中で終わった応答（#254）。サーバの
   * `messages.interrupted` をそのまま受ける。
   *
   * 「ユーザーが停止した」ではなく「この応答は途中で終わっており完結していない」
   * ことを表す（LLM 失敗・タイムアウトで部分テキストだけが残った場合も `1`）。
   * 定義の正本は `server/src/db/migrate.ts` の version 5 のコメント。
   */
  interrupted: number;
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
  | ({
      kind: "message";
      key: string;
      role: ChatRole;
      content: string;
      /**
       * `true` when this reply ended early and is not a complete answer
       * (Issue #254) — the user stopped the generation, or the LLM call
       * failed after some text had already arrived. Omitted (falsy) for
       * every complete message, and for user messages, which are never
       * partial. Drives the interrupted rendering in `ChatView`.
       */
      interrupted?: boolean;
    } & (
      | {
          /**
           * The server-persisted message id, and the session it belongs to
           * (Issue #377). Always set together by `buildTimeline`, which only
           * ever builds entries from persisted `ChatMessage`s (AC-38) — this
           * pair is intersected with the "neither" shape below (rather than
           * each field being independently optional) so a value with only
           * one of the two cannot be constructed: `selectRewriteRange`
           * requires both to identify a message, and a half-set entry would
           * silently fail that match and under-count a deletion (決定 6's
           * safeguard is only as good as this pairing).
           */
          messageId: number;
          sessionId: number;
        }
      | {
          /**
           * Both omitted for an entry `buildTimeline` did not build:
           * `useChat` appends these directly (an optimistic send, or a
           * streamed reply's `onDone`/interrupted-abort handling) without
           * looking them up. **Known gap (tracked for Issue #378, not this
           * ticket):** some of these entries *are* already server-persisted
           * by the time they exist on screen (the POST that created them has
           * resolved), so `selectRewriteRange` treating "no identifiers" as
           * "not part of any session's deletion range" under-counts a
           * rewrite that would in fact delete them — the conservative
           * failure mode of the two only because it never over-promises a
           * deletion. #378 closes this by having `useChat` attach the real
           * identifiers to every entry it appends, once they are known.
           */
          messageId?: undefined;
          sessionId?: undefined;
        }
    ))
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
