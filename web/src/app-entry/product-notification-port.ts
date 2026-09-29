import type { NotificationSender } from "../../../server/src/core-entry.js";

/**
 * 製品版の通知ポート（#579 S3・機能仕様 docs/features/tauri-in-app-runtime.md
 * 「通知ポート」）。毎分の検知（`createTicker`）へ渡す `NotificationSender` の
 * Tauri 実装で、Rust 側の `tauri-plugin-notification` のコマンド
 * `plugin:notification|notify` を `invoke` で直接呼ぶ（JS の `sendNotification`
 * は結果を返さないため使わない。`@tauri-apps/plugin-notification` は入れない）。
 *
 * - 解決 → `delivered: true`・`channel: "tauri-notification"`。デスクトップの
 *   プラグインは OS への表示の結果を捨てる（表示に失敗しても解決する）ため、
 *   これは「プラグインが受け付けた」の意味になる（機能仕様「やらないこと（S3）」）。
 * - 拒否（IPC・権限・引数の失敗）→ 例外にせず `delivered: false`・`channel: "none"`
 *   を返し、失敗をログに出す。戻り値は `scheduler-tick.ts` が送信履歴へ
 *   `delivered = 0` として書き戻す（握りつぶさない）。
 * - `url` は使わない（通知のクリックは現行も未配線）。
 */
export interface ProductNotificationPortDeps {
  /** `@tauri-apps/api/core` の `invoke`（テストで差し替える）。 */
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  logError: (message: string, error: unknown) => void;
}

export const PRODUCT_NOTIFICATION_COMMAND = "plugin:notification|notify";

export const PRODUCT_NOTIFICATION_FAILED_MESSAGE =
  "製品版の通知を送れませんでした（通知のコマンドが失敗しました）";

export function createProductNotificationPort(deps: ProductNotificationPortDeps): NotificationSender {
  return async ({ title, body }) => {
    try {
      await deps.invoke(PRODUCT_NOTIFICATION_COMMAND, { options: { title, body } });
      return { delivered: true, channel: "tauri-notification" };
    } catch (error) {
      deps.logError(PRODUCT_NOTIFICATION_FAILED_MESSAGE, error);
      return { delivered: false, channel: "none" };
    }
  };
}
