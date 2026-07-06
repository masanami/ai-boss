export const DECISION_STATUSES = ["active", "revised", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const APPEAL_VERDICTS = ["upheld", "revised"] as const;
export type AppealVerdict = (typeof APPEAL_VERDICTS)[number];

export interface Appeal {
  id: number;
  decision_id: number;
  content: string;
  verdict: AppealVerdict;
  response: string | null;
  created_at: string;
}

export interface DecisionRecord {
  id: number;
  session_id: number;
  task_id: number | null;
  content: string;
  rationale: string | null;
  status: DecisionStatus;
  created_at: string;
}

/** The shape returned by `GET /api/decisions`: each decision with its own
 * appeal history attached. */
export interface DecisionWithAppeals extends DecisionRecord {
  appeals: Appeal[];
}

/** The shape returned by `POST /api/decisions/:id/appeals`. `decision` is the
 * (possibly now-revised) original decision; `revisedDecision` is only present
 * when the boss's verdict was `revised`. */
export interface AppealSubmitResult {
  appeal: Appeal;
  decision: DecisionRecord;
  revisedDecision?: DecisionRecord;
}
