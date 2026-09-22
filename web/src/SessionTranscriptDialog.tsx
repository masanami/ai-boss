import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChatApiError, fetchSessionMessages } from "./chat-api";
import type { ChatMessage } from "./chat";
import type { Task } from "./task";
import TaskReferenceText from "./TaskReferenceText";
import "./ChatView.css";
import "./SessionTranscriptDialog.css";

// ChatView と同じ呼び名にそろえる（読み返す面で発言者の呼び名が変わると、
// 同じ会話が別物に見える）。
const ROLE_LABELS = { user: "自分", boss: "ボス" } as const;

type TranscriptState =
  | { status: "loading" }
  | { status: "ready"; messages: ChatMessage[] }
  | { status: "not_found" }
  | { status: "error" };

interface SessionTranscriptDialogProps {
  /** The session whose conversation to read (`decisions.session_id`). */
  sessionId: number;
  /**
   * Where it was opened from: the heading of the decision-log section the
   * record sits in — the task title, or `UNASSIGNED_SECTION_TITLE` for a
   * record with no `task_id` (親 #438 決定22). Several records can point at
   * one session (確証 (V)), so the conversation alone can't say which record
   * was opened.
   */
  sourceTitle: string;
  /** The opened record's `created_at`. */
  recordedAt: string;
  /** Resolves `#<id>` in boss replies, as the chat does; `null` = undecorated. */
  taskReferenceTasks: readonly Task[] | null;
  onClose: () => void;
}

/**
 * Read-only view of one session's conversation, opened from a mentoring
 * record in the decision log (Issue #564 / 親 #438 S3, 決定21・決定22).
 *
 * Deliberately **not** built on `ChatView` / `useChat` (確証 (T)・(U)): those
 * are bound to the active session, its send path and `mentoringTarget`. This
 * component only reads `GET /api/sessions/:id/messages` and renders it — no
 * input, no send, no rewrite, no session operations — so opening it cannot
 * touch the chat's state by construction.
 *
 * Messages are shown in the order the API returns them (oldest first,
 * `created_at ASC, id ASC`). Turns removed by a rewrite are simply absent;
 * gaps are not detected (決定22).
 */
function SessionTranscriptDialog({
  sessionId,
  sourceTitle,
  recordedAt,
  taskReferenceTasks,
  onClose,
}: SessionTranscriptDialogProps) {
  const [state, setState] = useState<TranscriptState>({ status: "loading" });
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchSessionMessages(sessionId).then(
      (messages) => {
        if (!cancelled) {
          setState({ status: "ready", messages });
        }
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        // 404 はサーバの契約どおり `code` で見分ける（文言では分岐しない。
        // docs/features/session-not-found-response-shape.md）。
        const notFound =
          error instanceof ChatApiError && error.code === "session_not_found";
        setState({ status: notFound ? "not_found" : "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 開いたら閉じるボタンへ、閉じたら開いた導線へフォーカスを戻す（長い決定
  // ログでキーボード操作の位置を失わないため）。
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      opener?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="session-transcript-backdrop">
      <div
        className="session-transcript"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-transcript-title"
        // 本文をクリックしてもフォーカスが面の中に残り、Escape が効くように。
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="session-transcript-header">
          <div className="session-transcript-origin">
            <h2 id="session-transcript-title" className="session-transcript-title">
              {sourceTitle}
            </h2>
            <span className="session-transcript-recorded-at">
              記録:{" "}
              <time dateTime={recordedAt}>
                {new Date(recordedAt).toLocaleString("ja-JP")}
              </time>
            </span>
          </div>
          <button
            type="button"
            className="session-transcript-close"
            ref={closeButtonRef}
            onClick={onClose}
          >
            閉じる
          </button>
        </div>
        <div className="session-transcript-body">
          <TranscriptBody state={state} taskReferenceTasks={taskReferenceTasks} />
        </div>
      </div>
    </div>
  );
}

function TranscriptBody({
  state,
  taskReferenceTasks,
}: {
  state: TranscriptState;
  taskReferenceTasks: readonly Task[] | null;
}) {
  switch (state.status) {
    case "loading":
      return <p className="session-transcript-status">会話を読み込み中…</p>;
    case "not_found":
      return (
        <p className="session-transcript-status" role="alert">
          この会話のセッションが見つかりません
        </p>
      );
    case "error":
      return (
        <p className="session-transcript-status" role="alert">
          会話の取得に失敗しました
        </p>
      );
    case "ready":
      if (state.messages.length === 0) {
        return <p className="session-transcript-status">このセッションに会話はありません</p>;
      }
      return (
        <ul className="session-transcript-list" aria-label="会話の記録">
          {state.messages.map((message) => (
            <li
              key={message.id}
              className={`chat-message chat-message-${message.role}${
                message.interrupted === 1 ? " chat-message-interrupted" : ""
              }`}
            >
              <span className="chat-message-role">{ROLE_LABELS[message.role]}</span>
              <p className="chat-message-content">
                {message.role === "boss" ? (
                  <TaskReferenceText text={message.content} tasks={taskReferenceTasks} />
                ) : (
                  message.content
                )}
              </p>
              {message.interrupted === 1 && (
                <span className="chat-message-interrupted-label">
                  ここで停止しました
                </span>
              )}
            </li>
          ))}
        </ul>
      );
  }
}

export default SessionTranscriptDialog;
