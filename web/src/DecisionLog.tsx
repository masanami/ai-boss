import { useDecisions } from "./use-decisions";
import type { DecisionRecord, DecisionStatus } from "./decision";
import "./DecisionLog.css";

const STATUS_LABEL: Record<DecisionStatus, string> = {
  active: "有効",
  revised: "修正済み",
  withdrawn: "取り下げ",
};

interface DecisionCardProps {
  decision: DecisionRecord;
}

function DecisionCard({ decision }: DecisionCardProps) {
  return (
    <li className="decision-card">
      <div className="decision-card-header">
        <span className={`decision-status decision-status-${decision.status}`}>
          {STATUS_LABEL[decision.status]}
        </span>
        <time dateTime={decision.created_at}>{decision.created_at}</time>
      </div>
      <p className="decision-content">{decision.content}</p>
      {decision.rationale !== null && (
        <p className="decision-rationale">根拠: {decision.rationale}</p>
      )}
      {decision.task_id !== null && (
        <p className="decision-task">関連タスク: #{decision.task_id}</p>
      )}
    </li>
  );
}

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

  return (
    <div className="decision-log">
      {decisions.length === 0 ? (
        <p className="decision-log-empty">決定はまだありません</p>
      ) : (
        <ul className="decision-list" aria-label="決定一覧">
          {decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default DecisionLog;
