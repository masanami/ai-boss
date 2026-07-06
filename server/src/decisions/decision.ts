export const DECISION_STATUSES = ["active", "revised", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface Decision {
  id: number;
  session_id: number;
  task_id: number | null;
  content: string;
  rationale: string | null;
  status: DecisionStatus;
  created_at: string;
}
