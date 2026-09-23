export const SESSION_TYPES = ["morning", "evening", "adhoc"] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export interface Session {
  id: number;
  type: SessionType;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}
