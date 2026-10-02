import type { NudgeSchedulerPort } from "../../../server/src/core-entry.js";

/**
 * 製品版の通知の予約ポート（#585 S3・機能仕様 docs/features/scheduled-nudges.md
 * 決定 6・「S3 の設計」の「通知の予約ポートの実装（製品版）」）。計画し直し
 * （`createNudgeReplanner`）へ渡す `NudgeSchedulerPort` の Tauri 実装で、器の
 * 通知プラグイン（リポジトリ内 fork `native/tauri-plugin-notification/`）の
 * コマンドを `invoke` で直接呼ぶ。即時の通知のポート（`product-notification-port.ts`）
 * と同じく、依存は引数で受ける。
 *
 * - `register`: `plugin:notification|notify` に予約時刻（`schedule.at`）を付けて
 *   呼ぶ。`date` は予約時刻を UTC で表した ISO 8601 の文字列（末尾 `Z`）で、
 *   JS 側では時差を補正しない（iOS は fork の差分 1 で UTC として読む）。
 * - 予約時刻が「今から 5 秒後」より前なら、「今から 5 秒後」に寄せて登録する
 *   （OS は登録の時点より前の予約を拒否するため。仮定 A2・A25）。控えの予約
 *   時刻は呼び出し側のまま変わらない。
 * - ID がプラグインの `i32` の正の範囲（1〜2,147,483,647）の外なら、`invoke` を
 *   呼ばずに例外で返す。
 * - `invoke` の拒否は、そのまま例外で返す（握りつぶさない。決定 6 の (2)）。
 * - `replacesSameId` は真（iOS は同じ識別子の登録を置き換えとして扱う。仕様の実測）。
 */
export interface ProductNudgeSchedulerPortDeps {
  /** `@tauri-apps/api/core` の `invoke`（テストで差し替える）。 */
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** 現在時刻（「今から 5 秒後」の「今」。テストで差し替える）。 */
  clock: () => Date;
}

export const NUDGE_NOTIFY_COMMAND = "plugin:notification|notify";
export const NUDGE_CANCEL_COMMAND = "plugin:notification|cancel";
export const NUDGE_GET_PENDING_COMMAND = "plugin:notification|get_pending";

/** 予約時刻を寄せる幅（仮定 A25。変えるときは受入基準も変える） */
export const MIN_SCHEDULE_LEAD_MS = 5_000;

/** プラグインの通知の ID（`i32`）の正の範囲の上限 */
export const MAX_NOTIFICATION_ID = 2_147_483_647;

export function createProductNudgeSchedulerPort(deps: ProductNudgeSchedulerPortDeps): NudgeSchedulerPort {
  return {
    replacesSameId: true,
    async register({ id, at, title, body }) {
      if (!Number.isInteger(id) || id < 1 || id > MAX_NOTIFICATION_ID) {
        throw new RangeError(`notification id out of range: ${id}`);
      }
      const earliest = deps.clock().getTime() + MIN_SCHEDULE_LEAD_MS;
      const scheduledAt = new Date(Math.max(at.getTime(), earliest));
      await deps.invoke(NUDGE_NOTIFY_COMMAND, {
        options: {
          id,
          title,
          body,
          schedule: { at: { date: scheduledAt.toISOString(), repeating: false, allowWhileIdle: false } },
        },
      });
    },
    async cancel(id) {
      await deps.invoke(NUDGE_CANCEL_COMMAND, { notifications: [id] });
    },
    async countPending() {
      const pending = await deps.invoke(NUDGE_GET_PENDING_COMMAND);
      if (!Array.isArray(pending)) {
        throw new TypeError("get_pending did not return a list");
      }
      return pending.length;
    },
  };
}
