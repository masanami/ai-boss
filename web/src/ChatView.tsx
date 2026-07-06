import { useEffect, useRef, useState } from "react";
import { useChat, type ChatEntry } from "./use-chat";
import type { ChatToolEvent } from "./chat";
import "./ChatView.css";

const ROLE_LABELS = { user: "自分", boss: "ボス" } as const;

const SESSION_TYPE_LABELS = { morning: "朝会中", evening: "夕会中" } as const;

function toolNoticeText(tool: ChatToolEvent): string {
  if (tool.isError) {
    return `タスク操作に失敗しました（${tool.name}）`;
  }

  let title: string | undefined;
  try {
    const parsed = JSON.parse(tool.result) as { title?: string };
    title = parsed.title;
  } catch {
    title = undefined;
  }
  const action = tool.name === "create_task" ? "作成" : "更新";
  return title
    ? `ボスがタスクを${action}しました: ${title}`
    : `ボスがタスクを${action}しました`;
}

function ChatEntryItem({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "tool") {
    return <li className="chat-tool-notice">{toolNoticeText(entry.tool)}</li>;
  }
  return (
    <li className={`chat-message chat-message-${entry.role}`}>
      <span className="chat-message-role">{ROLE_LABELS[entry.role]}</span>
      <p className="chat-message-content">{entry.content}</p>
    </li>
  );
}

function ChatView() {
  const {
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
  } = useChat();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries, streamingText]);

  if (status === "loading") {
    return <p className="chat-status">会話履歴を読み込み中…</p>;
  }
  if (status === "error") {
    return <p className="chat-status">会話履歴の読み込みに失敗しました</p>;
  }

  const canSend = !sending && !switching && draft.trim().length > 0;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) {
      return;
    }
    const content = draft.trim();
    setDraft("");
    void send(content);
  };

  return (
    <div className="chat-view">
      <div className="chat-session-bar">
        {sessionType === "adhoc" ? (
          <>
            <button
              type="button"
              onClick={() => void startSession("morning")}
              disabled={switching || sending}
            >
              朝会を開始
            </button>
            <button
              type="button"
              onClick={() => void startSession("evening")}
              disabled={switching || sending}
            >
              夕会を開始
            </button>
          </>
        ) : (
          <>
            <span className="chat-session-badge">
              {SESSION_TYPE_LABELS[sessionType]}
            </span>
            <button
              type="button"
              onClick={() => void endSession()}
              disabled={switching || sending}
            >
              セッションを終了
            </button>
          </>
        )}
      </div>
      <ul className="chat-timeline" aria-label="会話履歴">
        {entries.map((entry) => (
          <ChatEntryItem key={entry.key} entry={entry} />
        ))}
        {streamingText !== "" && (
          <li className="chat-message chat-message-boss chat-message-streaming">
            <span className="chat-message-role">{ROLE_LABELS.boss}</span>
            <p className="chat-message-content">{streamingText}</p>
          </li>
        )}
      </ul>
      <div ref={bottomRef} />
      {error !== null && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <form className="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="ボスに相談する…"
          aria-label="メッセージ"
          disabled={sending || switching}
        />
        <button type="submit" disabled={!canSend}>
          {sending ? "送信中…" : "送信"}
        </button>
      </form>
    </div>
  );
}

export default ChatView;
