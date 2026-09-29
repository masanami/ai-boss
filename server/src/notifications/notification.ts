/**
 * Row shape of the `notifications` table (server/src/db/migrate.ts). Records
 * every notification the scheduler *attempted* to send — the row is written
 * before the send (Issue #221), so a row does not by itself mean the user saw
 * it (see `delivered`) — and is the single source of truth for rule_key-scoped
 * escalation state (検知エンジン/スケジューラが参照する).
 */
export interface Notification {
  id: number;
  type: string;
  rule_key: string | null;
  escalation_level: number | null;
  body: string;
  sent_at: string;
  /**
   * Delivery outcome written back *after* the send (#321): `null` = unknown
   * (row predates v6, or the send outcome was never written back), `0` =
   * not delivered, `1` = delivered. Nullable by design — see migrate.ts v6.
   */
  delivered: number | null;
  /**
   * Which channel the send ended on, stored verbatim from the notifier's
   * result: `"terminal-notifier"` / `"osascript"` = delivered via that
   * channel, `"tauri-notification"` = the product build's notification
   * plugin accepted it (#579 S3; the desktop plugin discards the OS's display
   * result, so `delivered = 1` here means "accepted by the plugin", not "shown
   * by the OS"), `"none"` = no channel delivered it (pairs with
   * `delivered = 0`), `"scheduled"` = an OS scheduled notification confirmed
   * after its scheduled time (予約通知方式・#585 S2; whether the OS showed it
   * is unknown, so `delivered` stays null), `null` = unknown (see `delivered`). Kept as `string`
   * like `type` above: the persisted vocabulary is the notifier's, and the
   * column carries no CHECK constraint, so the row type does not pretend to
   * a narrower union than the DB guarantees.
   */
  channel: string | null;
}
