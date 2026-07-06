import { useState } from "react";
import type { FormEvent } from "react";
import { useDecisions } from "./use-decisions";
import type {
  AppealSubmitResult,
  AppealVerdict,
  DecisionStatus,
  DecisionWithAppeals,
} from "./decision";
import "./DecisionLog.css";

const STATUS_LABEL: Record<DecisionStatus, string> = {
  active: "有効",
  revised: "修正済み",
  withdrawn: "取り下げ",
};

const VERDICT_LABEL: Record<AppealVerdict, string> = {
  upheld: "維持",
  revised: "修正",
};

interface DecisionCardProps {
  decision: DecisionWithAppeals;
  onAppeal: (
    decisionId: number,
    content: string,
  ) => Promise<AppealSubmitResult>;
}

function DecisionCard({ decision, onAppeal }: DecisionCardProps) {
  const [isAppealing, setIsAppealing] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || draft.trim() === "") {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    onAppeal(decision.id, draft.trim())
      .then(() => {
        setIsAppealing(false);
        setDraft("");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "進言の送信に失敗しました");
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  return (
    <li className="decision-card">
      <div className="decision-card-header">
        <span
          className={`decision-status decision-status-${decision.status}`}
        >
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
      {decision.appeals.length > 0 && (
        <ul className="decision-appeals" aria-label="進言履歴">
          {decision.appeals.map((appeal) => (
            <li key={appeal.id} className="appeal-item">
              <p className="appeal-content">進言: {appeal.content}</p>
              <p
                className={`appeal-verdict appeal-verdict-${appeal.verdict}`}
              >
                裁定: {VERDICT_LABEL[appeal.verdict]}
              </p>
              {appeal.response !== null && (
                <p className="appeal-response">{appeal.response}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {decision.status === "active" && (
        <div className="decision-appeal-action">
          {!isAppealing ? (
            <button type="button" onClick={() => setIsAppealing(true)}>
              進言する
            </button>
          ) : (
            <form
              className="appeal-form"
              aria-label={`決定${decision.id}への進言`}
              onSubmit={handleSubmit}
            >
              <label>
                進言内容
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={isSubmitting}
                />
              </label>
              <div className="appeal-form-actions">
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "送信中…" : "送信"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsAppealing(false);
                    setError(null);
                    setDraft("");
                  }}
                  disabled={isSubmitting}
                >
                  キャンセル
                </button>
              </div>
              {error !== null && <p role="alert">{error}</p>}
            </form>
          )}
        </div>
      )}
    </li>
  );
}

function DecisionLog() {
  const { decisions, status, appeal } = useDecisions();

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
            <DecisionCard
              key={decision.id}
              decision={decision}
              onAppeal={appeal}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default DecisionLog;
