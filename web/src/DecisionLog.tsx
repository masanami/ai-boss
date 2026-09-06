import { useDecisions } from "./use-decisions";
import { groupDecisionsByTask } from "./group-decisions-by-task";
import type { DecisionSection } from "./group-decisions-by-task";
import type { DecisionKind, DecisionRecord } from "./decision";
import "./DecisionLog.css";

const KIND_LABEL: Record<DecisionKind, string> = {
  decision: "決定",
  mentoring: "メンタリング",
};

interface DecisionCardProps {
  decision: DecisionRecord;
}

function DecisionCard({ decision }: DecisionCardProps) {
  return (
    <li className="decision-card">
      <div className="decision-card-header">
        <span className={`decision-kind decision-kind-${decision.kind}`}>
          {KIND_LABEL[decision.kind]}
        </span>
        <time dateTime={decision.created_at}>{decision.created_at}</time>
      </div>
      <p className="decision-content">{decision.content}</p>
      {decision.rationale !== null && (
        <p className="decision-rationale">根拠: {decision.rationale}</p>
      )}
    </li>
  );
}

interface DecisionTaskSectionProps {
  section: DecisionSection;
}

function DecisionTaskSection({ section }: DecisionTaskSectionProps) {
  return (
    <section className="decision-section">
      <h3 className="decision-section-title">{section.title}</h3>
      <ul className="decision-list" aria-label={`${section.title}の記録`}>
        {section.records.map((decision) => (
          <DecisionCard key={decision.id} decision={decision} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The decision log, grouped into per-task sections (#358 判断1). No date
 * filter, no task picker, no collapsing: the screen has to answer both "what
 * did the boss decide about this task" and "what was decided recently" at
 * once, and a picker only answers the first. Decisions keep mattering across
 * days, so limiting the view to today would be a weak reference surface —
 * the dashboard and the daily report already cover today.
 */
function DecisionLog() {
  const { decisions, status } = useDecisions();

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

  return (
    <div className="decision-log">
      {sections.length === 0 ? (
        <p className="decision-log-empty">決定はまだありません</p>
      ) : (
        sections.map((section) => (
          <DecisionTaskSection
            key={section.taskId ?? "unassigned"}
            section={section}
          />
        ))
      )}
    </div>
  );
}

export default DecisionLog;
