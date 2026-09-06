export const DECISION_STATUSES = ["active", "revised", "withdrawn"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

// #358 判断3・#397（マイグレーション v8）: 決定ログのタスク軸再構成にあわせて
// 記録の種別を保持する列。'mentoring' を書く経路は #276 が足す — この時点
// では列と型のみ用意する（YAGNI との関係の意図的な受容、機能仕様参照）。
export const DECISION_KINDS = ["decision", "mentoring"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface Decision {
  id: number;
  session_id: number;
  task_id: number | null;
  content: string;
  rationale: string | null;
  status: DecisionStatus;
  kind: DecisionKind;
  created_at: string;
}
