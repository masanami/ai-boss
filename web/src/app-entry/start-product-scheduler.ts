import { createTicker, type DbPort } from "../../../server/src/core-entry.js";
import { createProductNotificationPort } from "./product-notification-port";

/**
 * 製品版の毎分の検知の起動（#579 S3・機能仕様
 * docs/features/tauri-in-app-runtime.md「毎分の刻みの供給元」「起動の順序」）。
 *
 * node-cron（開発者用の版）の置き換え。器の Rust 側のスレッドが毎分の境界で
 * メインのウィンドウへ送る刻みのイベント（`minute-tick`）を購読し、受けるたびに
 * `createTicker` の `tick` を 1 回走らせる。ウィンドウを隠しても WebView は
 * 止めない設定（`background_throttling: Disabled`）のため、刻みは届き続ける。
 *
 * - `env` は空（`process.env` を読まない）。LLM バックエンドは製品版のエントリが
 *   登録したものだけが使われ、無ければ既存の定型文へフォールバックする。
 * - 催促の予約の計画し直し（#585）はデスクトップでは配線しない。
 * - 購読の失敗は呼び出し側へ拒否で返す（描画を止めるかどうかは
 *   `boot-product-app.ts` が決める）。
 */

/** Rust 側（`native/tauri-app/src/desktop_shell.rs`）が毎分送るイベントの名前。 */
export const MINUTE_TICK_EVENT = "minute-tick";

export interface StartProductSchedulerDeps {
  db: DbPort;
  /** `@tauri-apps/api/event` の `listen`（テストで差し替える）。 */
  listen: (event: string, handler: () => void) => Promise<unknown>;
  /** `@tauri-apps/api/core` の `invoke`（製品版の通知ポートが使う）。 */
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  logError: (message: string, error: unknown) => void;
}

export async function startProductScheduler(deps: StartProductSchedulerDeps): Promise<void> {
  const ticker = createTicker({
    db: deps.db,
    env: {},
    sendNotification: createProductNotificationPort({
      invoke: deps.invoke,
      logError: deps.logError,
    }),
  });

  // `tick` は例外を投げない（失敗はログに出して握る）。前の刻みが処理中なら
  // その刻みを飛ばす（`createTicker` の並行実行の防止）。
  await deps.listen(MINUTE_TICK_EVENT, () => {
    void ticker.tick();
  });
}
