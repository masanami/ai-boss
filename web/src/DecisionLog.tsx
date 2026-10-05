import { useRef, useState } from "react";
import { decisionSectionId } from "./decision-section-id";
import { useDecisions } from "./use-decisions";
import { groupDecisionsByTask } from "./group-decisions-by-task";
import type { DecisionSection } from "./group-decisions-by-task";
import type { DecisionKind, DecisionRecord } from "./decision";
import type { Task } from "./task";
import type { TasksLoadStatus } from "./use-tasks";
import TaskReferenceText from "./TaskReferenceText";
import { referenceableTasks } from "./task-id-references";
import SessionTranscriptDialog from "./SessionTranscriptDialog";
import "./DecisionLog.css";

const KIND_LABEL: Record<DecisionKind, string> = {
  decision: "決定",
  mentoring: "メンタリング",
};

interface DecisionCardProps {
  decision: DecisionRecord;
  /**
   * Issue #513 (S1, 決定2・決定3): the task list to resolve `#<id>`
   * references in `decision.content` against, or `null` when unavailable
   * (loading/error). Deliberately not applied to `decision.rationale` (S3,
   * out of scope for this ticket).
   */
  taskReferenceTasks: readonly Task[] | null;
  /**
   * Issue #564 (S3, 親 #438 決定22): opens the record's session transcript.
   * Only rendered for `kind === "mentoring"` — S3 traces how a mentoring
   * went, and widening it to decision cards is a separate call.
   */
  onOpenTranscript: (decision: DecisionRecord) => void;
}

function DecisionCard({
  decision,
  taskReferenceTasks,
  onOpenTranscript,
}: DecisionCardProps) {
  return (
    <li className="decision-card">
      <div className="decision-card-header">
        <span className={`decision-kind decision-kind-${decision.kind}`}>
          {KIND_LABEL[decision.kind]}
        </span>
        <time dateTime={decision.created_at}>{decision.created_at}</time>
      </div>
      <p className="decision-content">
        <TaskReferenceText text={decision.content} tasks={taskReferenceTasks} />
      </p>
      {decision.rationale !== null && (
        <p className="decision-rationale">根拠: {decision.rationale}</p>
      )}
      {decision.kind === "mentoring" && (
        <div className="decision-card-actions">
          <button
            type="button"
            className="decision-transcript-button"
            onClick={() => onOpenTranscript(decision)}
          >
            会話を読み返す
          </button>
        </div>
      )}
    </li>
  );
}

interface DecisionTaskSectionProps {
  section: DecisionSection;
  taskReferenceTasks: readonly Task[] | null;
  onOpenTranscript: (record: OpenedRecord) => void;
}

function DecisionTaskSection({
  section,
  taskReferenceTasks,
  onOpenTranscript,
}: DecisionTaskSectionProps) {
  return (
    <section className="decision-section" id={decisionSectionId(section.taskId)}>
      <h3 className="decision-section-title">{section.title}</h3>
      <ul className="decision-list" aria-label={`${section.title}の記録`}>
        {section.records.map((decision) => (
          <DecisionCard
            key={decision.id}
            decision={decision}
            taskReferenceTasks={taskReferenceTasks}
            onOpenTranscript={(opened) =>
              onOpenTranscript({
                sessionId: opened.session_id,
                // 出自はこのセクションの見出しそのもの（決定22: 新しい文言を
                // 作らない。`#<task_id>` のフォールバックも見出しと同じになる）。
                sourceTitle: section.title,
                recordedAt: opened.created_at,
              })
            }
          />
        ))}
      </ul>
    </section>
  );
}

/** The mentoring record whose session transcript is open (Issue #564). */
interface OpenedRecord {
  sessionId: number;
  sourceTitle: string;
  recordedAt: string;
}

interface DecisionLogProps {
  /**
   * Issue #513 (S1, 決定2): the task list (`AppLayout`'s `tasksState`,
   * decomposed into these two fields since this component only ever reads
   * the list — it does not fetch its own copy, per 決定2) used to resolve
   * `#<id>` references in decision content. Both optional and defaulting to
   * "no decoration" so every pre-existing `<DecisionLog />` call (this
   * file's tests, `AppLayout`'s render prior to this change) keeps compiling
   * and behaving exactly as before.
   */
  tasks?: Task[];
  tasksStatus?: TasksLoadStatus;
  /**
   * Issue #689: the task to narrow the log to — set when the log was opened
   * from a task card's 記録を見る button, `null`/omitted when opened from the
   * navigation (which keeps the whole-log view of #358 判断1). Narrowing
   * replaced #557's scroll-to-section: the scroll did work, but for a task
   * with no records (no section), the newest section (already at the top) or
   * the last one (cannot reach the top) nothing visibly changed, so the
   * button looked like a plain page switch.
   *
   * Carries the title, not just the id, so the notice can name the task even
   * when it has no records (section titles come from the records).
   */
  filterTask?: DecisionLogFilterTask | null;
  /** Leaves the narrowed view for the whole log (すべての記録を表示). The
   * owner of `filterTask` (`AppLayout`) clears it in response. */
  onClearFilter?: () => void;
}

/** The task the log is narrowed to (Issue #689). */
export interface DecisionLogFilterTask {
  id: number;
  title: string;
}

/**
 * The decision log, grouped into per-task sections (#358 判断1). No date
 * filter, no task picker, no collapsing: the screen has to answer both "what
 * did the boss decide about this task" and "what was decided recently" at
 * once, and a picker only answers the first. Decisions keep mattering across
 * days, so limiting the view to today would be a weak reference surface —
 * the dashboard and the daily report already cover today.
 *
 * The one exception is arriving from a task card's 記録を見る (Issue #689):
 * then only that task's section is shown, with a way back to the whole log.
 * That is the card's own question, not a picker on this screen.
 */
function DecisionLog({
  tasks,
  tasksStatus,
  filterTask = null,
  onClearFilter,
}: DecisionLogProps = {}) {
  const { decisions, status } = useDecisions();
  // Issue #564 (S3): 読み取り専用の会話面で開いている記録。持ち主はここ
  // （`AppLayout` へ上げない）: 面は決定ログの上に重ねるだけで、ほかのビューと
  // 共有する状態が無い。`useChat` の状態には触れない（決定22）。
  const [openedRecord, setOpenedRecord] = useState<OpenedRecord | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  if (status === "loading") {
    return <p className="decision-log-status">決定ログを読み込み中…</p>;
  }
  if (status === "error") {
    return (
      <p className="decision-log-status" role="alert">
        決定ログの取得に失敗しました
      </p>
    );
  }

  const allSections = groupDecisionsByTask(decisions);
  const sections =
    filterTask === null
      ? allSections
      : allSections.filter((section) => section.taskId === filterTask.id);
  // Issue #513 (決定3): only resolve once the task list has actually loaded.
  const taskReferenceTasks = referenceableTasks(tasks, tasksStatus);

  // 「すべての記録を表示」は押すと自分自身が消える。フォーカスが body に
  // 落ちてキーボード操作の位置を見失わないよう、決定ログの先頭へ移す。
  const handleClearFilter = () => {
    onClearFilter?.();
    rootRef.current?.focus();
  };

  return (
    <div className="decision-log" ref={rootRef} tabIndex={-1}>
      {filterTask !== null && (
        <div className="decision-log-filter">
          <p className="decision-log-filter-notice">
            「{filterTask.title}」の記録だけを表示しています
          </p>
          <button type="button" onClick={handleClearFilter}>
            すべての記録を表示
          </button>
        </div>
      )}
      {sections.length === 0 ? (
        <p className="decision-log-empty">
          {filterTask === null
            ? "決定はまだありません"
            : "このタスクの記録はまだありません"}
        </p>
      ) : (
        sections.map((section) => (
          <DecisionTaskSection
            key={section.taskId ?? "unassigned"}
            section={section}
            taskReferenceTasks={taskReferenceTasks}
            onOpenTranscript={setOpenedRecord}
          />
        ))
      )}
      {openedRecord !== null && (
        <SessionTranscriptDialog
          // 記録を開き直したら取得状態を持ち越さない。
          key={`${openedRecord.sessionId}:${openedRecord.recordedAt}:${openedRecord.sourceTitle}`}
          sessionId={openedRecord.sessionId}
          sourceTitle={openedRecord.sourceTitle}
          recordedAt={openedRecord.recordedAt}
          taskReferenceTasks={taskReferenceTasks}
          onClose={() => setOpenedRecord(null)}
        />
      )}
    </div>
  );
}

export default DecisionLog;
