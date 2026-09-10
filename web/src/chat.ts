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
           * Both omitted for an entry `useChat` appends without looking up
           * its server id: the optimistic user message `send` appends before
           * its request resolves (AC-38b — there is no id yet), and a
           * streamed reply's interrupted-abort handling (`stop` landing
           * before `done`, also no id). `rewrite` (Issue #378) never
           * constructs an entry like this itself — on every exit from its
           * request (success or failure) it rebuilds *every* session in
           * today's view from the server, so every resulting entry goes
           * through `buildTimeline` and uses the "both set" branch above
           * instead. That is also true of `useChat`'s `messageEntry` helper
           * (used by `send`'s `onDone` for a completed reply, AC-38c),
           * which is what lets `selectRewriteRange` — now only used to
           * drive the rewrite confirmation UI's preview, not by `rewrite`
           * itself — count a mid-session rewrite's deletions correctly
           * without a reload.
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

/**
 * Shared options for `useChat().send` and `sendChatMessage` (Issue #470,
 * 親 #444 決定4): a single object used identically at both layers instead of
 * a growing list of trailing positional booleans/numbers. Keys follow the
 * existing undefined-as-absent contract (`replaceFromMessageId` before it) —
 * omitting a key (or the whole options object) leaves the request body
 * without that key at all (`mentoring` is typed `true`-only, so unlike
 * `replaceFromMessageId` there is no falsy value to pass instead).
 *
 * `mentoring` requests 随時メンタリング (Issue #411, 親 #276 判断6).
 * `mentoringTaskId` attributes the send to a specific task's card (Issue
 * #470, 親 #444 決定3) — the id, not the message text, is what the server
 * uses to associate the mentoring turn with a task.
 */
export interface SendMessageOptions {
  mentoring?: true;
  mentoringTaskId?: number;
}
