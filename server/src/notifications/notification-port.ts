/**
 * 通知ポート（機能仕様 docs/features/tauri-in-app-runtime.md「S3 の設計」
 * 「通知ポート」）。毎分の検知（`scheduler/scheduler-tick.ts`）が通知の送信を
 * 受け取る口の型で、Node 組み込みに依存しない（製品版のコアのバンドルに載る）。
 *
 * 実装は実行環境ごとに注入する: 開発者用の版は `notifier.ts` の
 * `sendNotification`（`terminal-notifier` → `osascript`）、製品版は
 * `web/src/app-entry/` の Tauri 実装。
 */

export interface NotificationPayload {
  title: string;
  body: string;
  /** クリック時に開く URL。terminal-notifier 経由のときのみクリックで開ける。 */
  url?: string;
}

/**
 * 送信に使った経路。`notifications.channel` に保存される文字列（CHECK 制約は
 * 無い）。`"none"` は全経路が失敗したことを表す。
 */
export type NotificationChannel =
  | "terminal-notifier"
  | "osascript"
  | "tauri-notification"
  | "none";

export interface SendNotificationResult {
  delivered: boolean;
  channel: NotificationChannel;
}

/** 通知の送信。失敗は例外ではなく戻り値（`delivered: false`）で返す。 */
export type NotificationSender = (
  payload: NotificationPayload,
) => Promise<SendNotificationResult>;
