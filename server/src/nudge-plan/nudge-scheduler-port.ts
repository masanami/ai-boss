/**
 * 通知の予約ポート（機能仕様 docs/features/scheduled-nudges.md 決定 6・
 * 「S2 の設計」）。S2 は型だけを置き、計画し直しの処理（`replan-nudges.ts`）
 * はこの型を通して OS の予約を扱う。製品版の実装（Tauri の通知プラグイン・
 * iOS の時差の手当て）は S3 が作る。
 */
export interface ScheduledNotificationRequest {
  /**
   * 予約の ID。控え（`nudge_reservations`）の行の ID をそのまま使う（Tauri の
   * 通知プラグインの ID は 32 ビット整数）。
   */
  id: number;
  /** 予約時刻 */
  at: Date;
  title: string;
  body: string;
}

export interface NudgeSchedulerPort {
  /**
   * 同じ ID での登録が、既存の予約の置き換えになるか（決定 4「OS が同じ予約
   * ID での登録を置き換えとして扱えるならそれを使い…」）。偽なら文面の
   * 差し替えは取り消し → 登録の順で行う。
   */
  readonly replacesSameId: boolean;
  /** 予約を登録する。失敗は例外で返す（握りつぶさない。決定 6 の (2)） */
  register(request: ScheduledNotificationRequest): Promise<void>;
  /** 予約を取り消す。失敗は例外で返す */
  cancel(id: number): Promise<void>;
}
