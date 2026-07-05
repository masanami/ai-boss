/**
 * Row shape of the `notifications` table (server/src/db/migrate.ts). Records
 * every notification actually sent, and is the single source of truth for
 * rule_key-scoped escalation state (未実装の検知エンジン/スケジューラが参照する).
 */
export interface Notification {
  id: number;
  type: string;
  rule_key: string | null;
  escalation_level: number | null;
  body: string;
  sent_at: string;
}
