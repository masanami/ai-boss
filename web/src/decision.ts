export const DECISION_STATUSES = ["active", "revised", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

// #358 判断3: 記録の種別。'mentoring' を書く経路は #276 が足す — この時点では
// 画面が種別を判別して表示できるところまでを用意する。
export const DECISION_KINDS = ["decision", "mentoring"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** The shape returned by `GET /api/decisions` (newest first).
 *
 * `task_title` is resolved server-side by a `LEFT JOIN tasks` so the decision
 * log can head each task section with a name without holding a task list of
 * its own (#358 判断5). It is `null` for decisions that carry no `task_id` —
 * the boss's `record_decision` tool takes `task_id` as an optional field, and
 * rulings like "tomorrow's standup moves to 9:30" legitimately have no task. */
export interface DecisionRecord {
  id: number;
  session_id: number;
  task_id: number | null;
  task_title: string | null;
  content: string;
  rationale: string | null;
  status: DecisionStatus;
  kind: DecisionKind;
  created_at: string;
}
