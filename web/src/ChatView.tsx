import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UseChatResult } from "./use-chat";
import type { ChatEntry, ChatToolEvent, MeetingSessionType } from "./chat";
import { selectRewriteRange, type RewriteRange } from "./select-rewrite-range";
import "./ChatView.css";

const ROLE_LABELS = { user: "自分", boss: "ボス" } as const;

const SESSION_TYPE_LABELS = { morning: "朝会中", evening: "夕会中" } as const;

const SESSION_END_LABELS = {
  morning: "朝会を終了",
  evening: "夕会を終了",
} as const;

// Issue #411 (親 #276 判断6): 随時メンタリングのボタンが送る定型のユーザー
// 発言。`mentoring: true` を必ず伴わせる（`send` の第2引数）— フラグ無しの
// 定型文だけでは MENTORING_FLOW_INSTRUCTION が積まれず、随時メンタリングだ
// け記録（`record_mentoring`）が残らない（機能仕様「画面・API設計」）。
const MENTORING_MESSAGE_CONTENT = "今の進め方を見てほしい";
const MENTORING_BUTTON_LABEL = "進め方を点検してもらう";

// AC-39/AC-40: `code` 一致（`mentoringRequired`）で分岐する状態表示。
// エラー文言をそのまま出さず、逃げ道（設定でオフ）を必ず併記する — これを
// 欠くと、ボスがメンタリングの記録を残さなかった場合にユーザーが朝会から
// 抜ける手段を画面から見つけられなくなる（ADR 0008 決定2 と同じ作法）。
const MENTORING_BLOCKED_MESSAGE =
  "仕事の進め方のメンタリングを終えると朝会を終了できます（設定でメンタリングの強制をオフにすることもできます）";

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

/** Everything the inline confirmation form (Issue #379, 決定 6) needs for the
 * one entry currently being edited. Bundled into a single object — rather
 * than passing `range`/`draft`/the callbacks alongside a separate `isEditing`
 * boolean — so that "editing this entry, but no range computed yet" cannot be
 * represented: earlier revisions of this component had `isEditing: true` and
 * `range: null` as two independently-settable props, and the resulting
 * "editing but nothing to show" state silently fell through to rendering a
 * plain bubble instead of the form (self-review, Issue #379). With `range`
 * required (non-nullable) inside this type, the caller can only ever produce
 * a `rewriteForm` for an entry once a real, non-empty range exists for it. */
interface ChatRewriteFormProps {
  range: RewriteRange;
  draft: string;
  onDraftChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

interface ChatEntryItemProps {
  entry: ChatEntry;
  /** Whether an edit affordance should render on this entry (画面の仕様: the
   * four conditions — own message, persisted, active session, not mid-send/
   * switch). Computed by the caller since it also depends on
   * `activeSessionId`/`sending`/`switching`/whether another edit is already
   * open, none of which this component owns. */
  canEdit: boolean;
  /** True for every other entry that a confirmed edit would delete
   * (`selectRewriteRange`'s `keys`, 決定 6 / 導出決定 6-a・6-b) — highlighted
   * so the user can see the range before committing. */
  isHighlighted: boolean;
  onStartEdit: () => void;
  /** Non-null for exactly the single entry currently being edited; `null`
   * for every other entry, including every non-message entry. */
  rewriteForm: ChatRewriteFormProps | null;
}

function ChatEntryItem({
  entry,
  canEdit,
  isHighlighted,
  onStartEdit,
  rewriteForm,
}: ChatEntryItemProps) {
  if (entry.kind === "tool") {
    return (
      <li
        className={`chat-tool-notice${isHighlighted ? " chat-rewrite-target" : ""}`}
      >
        {toolNoticeText(entry.tool)}
      </li>
    );
  }
  if (entry.kind === "boundary") {
    // A rule with the label inline: the divider is what makes "どこからどこ
    // までが会か" readable at a glance when scrolling, so the boundary is
    // drawn as a separator rather than as another centered notice line
    // (which would be indistinguishable from a tool notice). Boundaries are
    // never part of a rewrite range (決定6 導出決定 6-a says "実際に削除され
    // る個々のエントリ" only — `selectRewriteRange` never emits a boundary
    // key), so there is no highlighting branch here.
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

  // kind === "message". While this particular message is the one being
  // edited, it turns into the inline confirmation form in place of its own
  // bubble (Issue #379, 決定 6) — no separate listitem is added, keeping the
  // existing `getAllByRole("listitem")` contract.
  if (rewriteForm !== null) {
    const { range, draft, onDraftChange, onConfirm, onCancel } = rewriteForm;
    // `range.total === 0` defends against a range that turned out empty by
    // the time the form rendered (`selectRewriteRange` cannot find the
    // target — self-review, Issue #379): rather than let a "0件が削除され
    // ます" preview stay confirmable, disable the one action that would
    // execute against it. `ChatView` also prevents the scenario that used to
    // reach this (a session switch mid-edit) by disabling the session-bar
    // buttons while editing, so this is defense in depth, not the only
    // guard.
    const canConfirm = draft.trim().length > 0 && range.total > 0;
    return (
      <li className="chat-message chat-rewrite-form">
        <span className="chat-message-role">{ROLE_LABELS[entry.role]}</span>
        <textarea
          className="chat-rewrite-textarea"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          aria-label="書き直す内容"
          autoFocus
        />
        {/* 決定 6: 実行前に消える範囲を必ず提示する。N は対象発言自身を含む
            （明示的な仮定 5）。文言はテストの期待値そのものなので変更時は
            同じ変更でテストも直す。 */}
        <p className="chat-rewrite-summary">
          {`この操作でこの発言を含む${range.total}件（あなたの発言${range.userCount}件・ボスの応答${range.bossCount}件）が削除されます`}
        </p>
        {/* 決定 4・導出決定 6-b: ツール通知は画面から消えても副作用は残る。
            この文言だけがその唯一の周知手段なので省略しない。 */}
        <p className="chat-rewrite-warning">
          すでに実行された操作は取り消されません
        </p>
        <div className="chat-rewrite-actions">
          <button
            type="button"
            className="chat-rewrite-confirm"
            onClick={onConfirm}
            disabled={!canConfirm}
          >
            送り直す
          </button>
          <button
            type="button"
            className="chat-rewrite-cancel"
            onClick={onCancel}
          >
            キャンセル
          </button>
        </div>
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
      }${isHighlighted ? " chat-rewrite-target" : ""}`}
    >
      <span className="chat-message-role">{ROLE_LABELS[entry.role]}</span>
      <p className="chat-message-content">{entry.content}</p>
      {entry.interrupted === true && (
        <span className="chat-message-interrupted-label">
          ここで停止しました
        </span>
      )}
      {/* キーボードで到達でき、テストから安定して取得できる通常のボタン
          （明示的な仮定 4）。ホバー時のみ見せる CSS を足すのは構わないが、
          ホバー専用の実装（DOM から消す／pointer-events だけで出す）は
          採らない。 */}
      {canEdit && (
        <button
          type="button"
          className="chat-edit-button"
          onClick={onStartEdit}
        >
          発言を編集
        </button>
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
    mentoringRequired,
    activeSessionId,
    draft,
    setDraft,
    send,
    rewrite,
    stop,
    startSession,
    endSession,
  } = chatState;
  const timelineRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Inline edit state (Issue #379, #255 決定6). Kept local to `ChatView`
  // rather than lifted into `useChat`/`AppLayout`: an in-progress edit is
  // transient UI state, not conversation state, so losing it on a tab switch
  // (this component unmounting, Issue #93) is an accepted trade-off — the
  // same one `draft` deliberately does *not* take (draft is lifted because
  // losing typed-but-unsent text was judged worse). `editingMessageId` is the
  // server-persisted id of the message currently being edited, or `null`
  // when no edit is open.
  const [editingMessageId, setEditingMessageId] = useState<number | null>(
    null,
  );
  const [rewriteDraft, setRewriteDraft] = useState("");
  // Set the moment `confirmEdit` fires, cleared once that attempt has
  // settled (the effect below). Lets that effect tell "a rewrite I just
  // confirmed finished" apart from "an unrelated `send` finished" — both
  // flip `sending` back to `false` the same way (self-review, Issue #379:
  // without this, restoring a failed edit could not tell which send it was
  // reacting to).
  const pendingRewriteRef = useRef<{ messageId: number; content: string } | null>(
    null,
  );

  // The deletion preview (決定 6) — recomputed on every render from the
  // current `entries`/`activeSessionId` rather than snapshotted at edit-start,
  // so it never goes stale if a tool notice streams in for another entry
  // while this edit form is open (not expected in practice since generation
  // is blocked while editing, but a snapshot would be one more thing to keep
  // in sync for no benefit). `null` whenever nothing is being edited, or
  // `activeSessionId` is unknown (guards `selectRewriteRange`'s required
  // argument; canEdit below never allows entering edit mode without an
  // active session, so this null case only matters transiently).
  const rewriteRange: RewriteRange | null =
    editingMessageId !== null && activeSessionId !== null
      ? selectRewriteRange(entries, activeSessionId, editingMessageId)
      : null;
  const rewriteKeys =
    rewriteRange !== null ? new Set(rewriteRange.keys) : null;

  const startEdit = (messageId: number, content: string) => {
    setEditingMessageId(messageId);
    setRewriteDraft(content);
  };

  const cancelEdit = () => {
    setEditingMessageId(null);
    setRewriteDraft("");
  };

  const confirmEdit = () => {
    if (
      editingMessageId === null ||
      rewriteDraft.trim().length === 0 ||
      rewriteRange === null ||
      rewriteRange.total === 0
    ) {
      return;
    }
    const messageId = editingMessageId;
    const content = rewriteDraft.trim();
    // Closed before `rewrite` is even called (not after it resolves): `send`
    // and `rewrite` share the same `sendingRef` guard, so the moment this
    // fires, `sending` becomes true and no entry can offer a new edit anyway
    // (導出決定 6-c) — leaving the form open would just show stale content
    // until `rewrite`'s server-driven timeline rebuild replaces it. If the
    // attempt fails, the effect below reopens the form with `content`
    // restored rather than letting it vanish silently.
    pendingRewriteRef.current = { messageId, content };
    setEditingMessageId(null);
    setRewriteDraft("");
    void rewrite(messageId, content);
  };

  // Recovers a rewritten draft that never made it to the server (self-review,
  // Issue #379): `confirmEdit` above already cleared the form optimistically,
  // the same way `send` clears the input before its request resolves. `send`
  // can get away with that because its optimistic entry keeps the text on
  // screen regardless of outcome; `rewrite` has no such entry (it rebuilds
  // the timeline from the server on every exit path instead), so a failed or
  // stopped attempt would otherwise lose what the user just retyped with no
  // way to recover it — a rougher edge than `send`'s, since here the text
  // came from *editing* an existing message, not fresh typing.
  //
  // Fires once per confirmed attempt, when `sending` drops back to `false`
  // (the same signal `rewrite`'s own `finally` uses to mark itself done).
  // `pendingRewriteRef` distinguishes "the rewrite I just confirmed settled"
  // from "an unrelated `send` finished" — both flip `sending` the same way.
  // Only restores when the original message is still present: a rewrite
  // whose commit is uncertain always refreshes the timeline from the server
  // (`rewrite`'s own doc comment), so if that message is gone, the server
  // truncation actually happened and there is nothing left to edit back into
  // — reopening the form here would invite a second, compounding rewrite
  // against content that no longer exists.
  useEffect(() => {
    if (sending) {
      return;
    }
    const pending = pendingRewriteRef.current;
    if (pending === null) {
      return;
    }
    pendingRewriteRef.current = null;
    // A stop deliberately does not set `error` (`rewrite`'s own `catch`,
    // mirroring `send`'s AC-23 — "a stop is not an error"), so it is
    // deliberately not treated as a failure to recover from here either: its
    // outcome is uncertain by construction (the request may have committed
    // on the server before the abort landed), and `rewrite`'s unconditional
    // refresh already shows whatever the server actually ended up with.
    // Reopening the form on top of that would risk a second, compounding
    // rewrite. Only a genuine rejection (bad request, already-ended session,
    // network failure, ...) reaches here with `error` set.
    if (error === null) {
      return;
    }
    // Requires `sessionId === activeSessionId` in addition to the id match
    // (mirroring `isEditingThis` below) — not just defense in depth: without
    // it, restoring into a message whose session is no longer active would
    // recreate the exact stuck state the session-bar disablement above
    // exists to prevent (`rewriteForm` only renders while `isEditingThis` is
    // true, so `editingMessageId` could end up set with no form ever able to
    // render for it again — self-review, Issue #379 round 2).
    const stillEditable = entries.some(
      (entry) =>
        entry.kind === "message" &&
        entry.messageId === pending.messageId &&
        entry.sessionId === activeSessionId,
    );
    if (stillEditable) {
      setEditingMessageId(pending.messageId);
      setRewriteDraft(pending.content);
    }
  }, [sending, error, entries, activeSessionId]);

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

  // 編集中は下部の通常入力欄を無効化する（送信経路が 2 つ同時に開かない、
  // 画面の仕様）。
  const canSend =
    !sending && !switching && editingMessageId === null && draft.trim().length > 0;

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
      {/* 編集中は開始/終了ボタンをすべて無効化する（Issue #379, self-review）:
          会を切り替えると `activeSessionId` が変わり、編集中のプレビュー
          （`selectRewriteRange`）が対象を見失う。会の開始/終了はこのボタン
          群からしか起きないので、ここを塞げば編集中にアクティブセッション
          が変わる経路は無くなる。 */}
      <div className="chat-session-bar">
        {sessionType === "adhoc" ? (
          <>
            <button
              type="button"
              onClick={() => void startSession("morning")}
              disabled={switching || sending || editingMessageId !== null}
            >
              朝会を開始
            </button>
            <button
              type="button"
              onClick={() => void startSession("evening")}
              disabled={switching || sending || editingMessageId !== null}
            >
              夕会を開始
            </button>
            {/* 随時メンタリングの導線（Issue #411, 親 #276 判断6）。`adhoc`
                （会でない区間）のときだけ表示する — 朝会・夕会の会中は、その
                会のフロー指示が既に会話を主導しているため、ここに置かない
                （「画面・API設計」）。 */}
            <button
              type="button"
              onClick={() =>
                void send(MENTORING_MESSAGE_CONTENT, { mentoring: true })
              }
              disabled={switching || sending || editingMessageId !== null}
            >
              {MENTORING_BUTTON_LABEL}
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
              disabled={switching || sending || editingMessageId !== null}
            >
              {SESSION_END_LABELS[sessionType]}
            </button>
          </>
        )}
      </div>
      {/* AC-39/AC-40: `code` から導出された `mentoringRequired` だけで出す
          （`error` の文言は使わない）。逃げ道（設定でオフ）を必ず併記する
          文言は上の定数側で固定している。`role="status"` は非侵入的な通知
          （`chat-error` の `role="alert"` ほど強く割り込まない）にするため
          — ブロックは失敗ではなく、次に何をすればいいかを示す状態である。 */}
      {mentoringRequired && (
        <p className="chat-mentoring-blocked" role="status">
          {MENTORING_BLOCKED_MESSAGE}
        </p>
      )}
      <ul className="chat-timeline" aria-label="会話履歴" ref={timelineRef}>
        {entries.map((entry) => {
          // 編集操作を出す条件（画面の仕様、すべて満たすときだけ）: 自分の
          // 発言・サーバ永続化済み・アクティブセッション・生成中/切替中でない
          // ・他の編集が開いていない。
          const canEdit =
            editingMessageId === null &&
            !sending &&
            !switching &&
            entry.kind === "message" &&
            entry.role === "user" &&
            entry.messageId !== undefined &&
            entry.sessionId === activeSessionId;
          // `entry.sessionId === activeSessionId` is included here (not just
          // the `messageId` match) as defense in depth: the session-bar
          // buttons already prevent `activeSessionId` from changing while an
          // edit is open (self-review, Issue #379), but should that
          // invariant ever break, this keeps the form from attaching itself
          // to an entry that is no longer in the active session.
          const isEditingThis =
            editingMessageId !== null &&
            entry.kind === "message" &&
            entry.messageId === editingMessageId &&
            entry.sessionId === activeSessionId;
          // 対象発言自身はフォームに置き換わるので、ハイライト対象からは
          // 除く（導出決定 6-a・6-b: ハイライトは「対象以降で削除される
          // 他のエントリ」を示す役目）。
          const isHighlighted =
            !isEditingThis &&
            rewriteKeys !== null &&
            rewriteKeys.has(entry.key);
          return (
            <ChatEntryItem
              key={entry.key}
              entry={entry}
              canEdit={canEdit}
              isHighlighted={isHighlighted}
              onStartEdit={() => {
                if (entry.kind === "message" && entry.messageId !== undefined) {
                  startEdit(entry.messageId, entry.content);
                }
              }}
              rewriteForm={
                isEditingThis && rewriteRange !== null
                  ? {
                      range: rewriteRange,
                      draft: rewriteDraft,
                      onDraftChange: setRewriteDraft,
                      onConfirm: confirmEdit,
                      onCancel: cancelEdit,
                    }
                  : null
              }
            />
          );
        })}
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
          disabled={sending || switching || editingMessageId !== null}
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
