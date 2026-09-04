import { useEffect, useLayoutEffect, useRef } from "react";
import type { UseChatResult } from "./use-chat";
import type { ChatEntry, ChatToolEvent, MeetingSessionType } from "./chat";
import "./ChatView.css";

const ROLE_LABELS = { user: "自分", boss: "ボス" } as const;

const SESSION_TYPE_LABELS = { morning: "朝会中", evening: "夕会中" } as const;

const SESSION_END_LABELS = {
  morning: "朝会を終了",
  evening: "夕会を終了",
} as const;

// Only tools that actually create/update a task get the task-specific
// "作成/更新" notice below. Every other BOSS_TOOLS entry (record_decision,
// get_activity_log, ...) used to fall through to the "更新" branch by
// default, which became an observably false claim ("ボスがタスクを更新しま
// した") once get_activity_log — a read-only tool called on essentially
// every completion report — was added (self-review, Issue #150).
const TASK_WRITE_TOOL_ACTIONS: Record<string, string> = {
  create_task: "作成",
  update_task: "更新",
};

function toolNoticeText(tool: ChatToolEvent): string {
  if (tool.isError) {
    return `ツールの実行に失敗しました（${tool.name}）`;
  }

  const action = TASK_WRITE_TOOL_ACTIONS[tool.name];
  if (action === undefined) {
    return "ボスがツールを実行しました";
  }

  let title: string | undefined;
  try {
    const parsed = JSON.parse(tool.result) as { title?: string };
    title = parsed.title;
  } catch {
    title = undefined;
  }
  return title
    ? `ボスがタスクを${action}しました: ${title}`
    : `ボスがタスクを${action}しました`;
}

// 明示的な仮定4（Issue #272）: 会の区間を示すのが目的なので、随時チャットは
// 「会でない区間」として境界の外側になり、専用の文言を持たない。`adhoc` が
// この Record に無いのは意図的で、`MeetingSessionType` が型で保証している。
const BOUNDARY_LABELS: Record<MeetingSessionType, Record<"start" | "end", string>> = {
  morning: { start: "朝会が開始されました", end: "朝会が終了しました" },
  evening: { start: "夕会が開始されました", end: "夕会が終了しました" },
};

function ChatEntryItem({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "tool") {
    return <li className="chat-tool-notice">{toolNoticeText(entry.tool)}</li>;
  }
  if (entry.kind === "boundary") {
    // A rule with the label inline: the divider is what makes "どこからどこ
    // までが会か" readable at a glance when scrolling, so the boundary is
    // drawn as a separator rather than as another centered notice line
    // (which would be indistinguishable from a tool notice).
    return (
      <li
        className={`chat-boundary chat-boundary-${entry.event}`}
        data-session-type={entry.sessionType}
      >
        <span className="chat-boundary-label">
          {BOUNDARY_LABELS[entry.sessionType][entry.event]}
        </span>
      </li>
    );
  }
  // 中断された応答（Issue #254）。ツール通知（中央の小さな札）・会の境界
  // （左右いっぱいの罫線）に続く第 3 の語彙として、**吹き出し自体に手を入れる**
  // 形にした。前の 2 つが「会話の流れに差し挟まれる独立した要素」なのに対し、
  // 中断は「この発言がどういう状態か」の注記なので、独立した行として置くと
  // どの応答が切れたのか対応づかなくなる。左の縁を切り落として途切れた紙片の
  // ように見せ、本文末尾には省略記号を、下に小さなラベルを添える。
  return (
    <li
      className={`chat-message chat-message-${entry.role}${
        entry.interrupted === true ? " chat-message-interrupted" : ""
      }`}
    >
      <span className="chat-message-role">{ROLE_LABELS[entry.role]}</span>
      <p className="chat-message-content">{entry.content}</p>
      {entry.interrupted === true && (
        <span className="chat-message-interrupted-label">
          ここで停止しました
        </span>
      )}
    </li>
  );
}

interface ChatViewProps {
  /**
   * Chat state, lifted up to `AppLayout` so it survives `ChatView` being
   * unmounted on tab switches (Issue #93; same pattern as `TaskBoard`
   * receiving `tasksState`, Issue #70).
   */
  chatState: UseChatResult;
}

function ChatView({ chatState }: ChatViewProps) {
  const {
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
    stop,
    startSession,
    endSession,
  } = chatState;
  const timelineRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Layout effect (not a plain effect) so the scroll position is settled
  // before the browser paints, avoiding a visible "top flashes, then jumps
  // to bottom" flicker when the history first mounts.
  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (el === null) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [entries, streamingText]);

  // Grow the input with its content. Resetting to "auto" first lets it shrink
  // again when lines are removed; the min/max bounds live in ChatView.css so
  // the clamp is expressed once.
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  // ESC で生成を止める（Issue #254、Claude Code の中断キーに相当）。
  //
  // **textarea の onKeyDown には置けない**: 生成中の textarea は disabled で、
  // disabled な要素はフォーカスを受けずキーイベントも発火しないため、Enter
  // 送信と同じ場所へ足しても動かない。生成中だけドキュメントを購読する。
  useEffect(() => {
    if (!sending) {
      return;
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // 変換中の ESC は IME のもの（変換の取り消し）であって、生成の停止では
      // ない。Enter 送信が同じ配慮をしているのと揃えている。
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      stop();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [sending, stop]);

  if (status === "loading") {
    return <p className="chat-status">会話履歴を読み込み中…</p>;
  }
  if (status === "error") {
    return <p className="chat-status">会話履歴の読み込みに失敗しました</p>;
  }

  const canSend = !sending && !switching && draft.trim().length > 0;

  const submitDraft = () => {
    if (!canSend) {
      return;
    }
    const content = draft.trim();
    setDraft("");
    void send(content);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitDraft();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter is the newline; plain Enter always means "send", so it never
    // inserts a line break even when the draft is not sendable yet.
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    // An Enter that commits an IME conversion (Japanese input) must reach the
    // IME, not the send handler. `keyCode === 229` is the same signal for
    // engines that do not report `isComposing`.
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    submitDraft();
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
              {SESSION_END_LABELS[sessionType]}
            </button>
          </>
        )}
      </div>
      <ul className="chat-timeline" aria-label="会話履歴" ref={timelineRef}>
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
      {error !== null && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="ボスに相談する…"
          aria-label="メッセージ"
          disabled={sending || switching}
        />
        {/* 生成中は送信ボタンを停止ボタンへ差し替える（Issue #254）。無効化
            された送信ボタンを見せて待たせるのではなく、同じ位置がそのまま
            「止める」手段になる（ChatGPT と同じ）。 */}
        {sending ? (
          <button
            type="button"
            className="chat-stop-button"
            onClick={stop}
            aria-label="生成を停止"
          >
            停止
          </button>
        ) : (
          <button type="submit" disabled={!canSend}>
            送信
          </button>
        )}
      </form>
    </div>
  );
}

export default ChatView;
