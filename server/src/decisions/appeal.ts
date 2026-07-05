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
