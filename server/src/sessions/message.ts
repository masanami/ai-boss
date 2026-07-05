export const MESSAGE_ROLES = ["user", "boss"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface Message {
  id: number;
  session_id: number;
  role: MessageRole;
  content: string;
  created_at: string;
}
