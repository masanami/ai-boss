import { useEffect } from "react";
import { decisionSectionId } from "./decision-section-id";
import { useDecisions } from "./use-decisions";
import { groupDecisionsByTask } from "./group-decisions-by-task";
import type { DecisionSection } from "./group-decisions-by-task";
import type { DecisionKind, DecisionRecord } from "./decision";
import type { Task } from "./task";
import type { TasksLoadStatus } from "./use-tasks";
import TaskReferenceText from "./TaskReferenceText";
import { referenceableTasks } from "./task-id-references";
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
}

function DecisionCard({ decision, taskReferenceTasks }: DecisionCardProps) {
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
    </li>
  );
}

interface DecisionTaskSectionProps {
  section: DecisionSection;
  taskReferenceTasks: readonly Task[] | null;
}

function DecisionTaskSection({
  section,
  taskReferenceTasks,
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
          />
        ))}
      </ul>
    </section>
  );
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
   * Issue #557 (S2a, 親 #438 決定15): the task whose section to scroll into
   * view once the log has loaded — set when the log was opened from a task
   * card's 記録を見る button, `null`/omitted when opened from the navigation.
   */
  scrollTargetTaskId?: number | null;
  /**
   * Called once the target above has been consumed, i.e. as soon as the fetch
   * has settled — **whether or not anything was scrolled** (no section for
   * that task, empty log, fetch error, no `scrollIntoView` in this
   * environment). The owner of the state (`AppLayout`) clears it in response;
   * this component keeps no state of its own about it. If consumption were
   * conditional on having scrolled, a stale target would survive this
   * component's unmount and fire on a later reopen from the navigation.
   *
   * Must be referentially stable (it is an effect dependency): an inline
   * arrow from a caller that does not clear the target would re-run the
   * scroll on every parent render.
   */
  onScrollTargetConsumed?: () => void;
}

/**
 * The decision log, grouped into per-task sections (#358 判断1). No date
 * filter, no task picker, no collapsing: the screen has to answer both "what
 * did the boss decide about this task" and "what was decided recently" at
 * once, and a picker only answers the first. Decisions keep mattering across
 * days, so limiting the view to today would be a weak reference surface —
 * the dashboard and the daily report already cover today.
 */
function DecisionLog({
  tasks,
  tasksStatus,
  scrollTargetTaskId = null,
  onScrollTargetConsumed,
}: DecisionLogProps = {}) {
  const { decisions, status } = useDecisions();

  // Runs after the commit that rendered the sections (or the empty/error
  // state), so the target section — if there is one — is already in the DOM.
  useEffect(() => {
    if (status === "loading" || scrollTargetTaskId === null) {
      return;
    }
    const section = document.getElementById(
      decisionSectionId(scrollTargetTaskId),
    );
    // Defensive: jsdom (and, in principle, a very old browser) doesn't
    // implement scrollIntoView. Same stance as AppLayout's setPointerCapture.
    if (section !== null && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ block: "start" });
    }
    onScrollTargetConsumed?.();
  }, [status, scrollTargetTaskId, onScrollTargetConsumed]);

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

  const sections = groupDecisionsByTask(decisions);
  // Issue #513 (決定3): only resolve once the task list has actually loaded.
  const taskReferenceTasks = referenceableTasks(tasks, tasksStatus);

  return (
    <div className="decision-log">
      {sections.length === 0 ? (
        <p className="decision-log-empty">決定はまだありません</p>
      ) : (
        sections.map((section) => (
          <DecisionTaskSection
            key={section.taskId ?? "unassigned"}
            section={section}
            taskReferenceTasks={taskReferenceTasks}
          />
        ))
      )}
    </div>
  );
}

export default DecisionLog;
