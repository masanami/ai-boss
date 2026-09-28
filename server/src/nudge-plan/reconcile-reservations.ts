import type { FiringNotification, NotificationHistoryEntry } from "../detection/detection-types.js";

/**
 * 予約の控え 1 件の最小形（機能仕様 docs/features/scheduled-nudges.md
 * クリティカル設計決定 2・IF/API）。`FiringNotification`（`planNudges` の
 * `PlannedNudge` の基底型）を拡張することで、計画層の出力（発火）と突き合わせ
 * の入力（控え）が同じ4フィールド（ruleType/ruleKey/escalationLevel/taskId）
 * を共有していることを型で表す。予約時刻は DB 行の形に合わせ ISO8601 文字列
 * で持つ（`PlannedNudge.scheduledAt: Date` とは異なる。S2 で控えへ書くときに
 * `.toISOString()` する）。S2 で予約 ID 等のフィールドを足しても
 * `reconcileReservations` の `<R extends ReservationRecord>` により保たれる。
 */
export interface ReservationRecord extends FiringNotification {
  /** 予約の種類。省略時は催促（S1 の控えの形との後方互換） */
  kind?: "nudge";
  /** 予約時刻（ISO8601） */
  scheduledAt: string;
  /** 有効か、OS での取り消し待ちか */
  state: "active" | "pending_cancel";
}

/**
 * 固定の「アプリを開いて報告しろ」通知の控え（機能仕様 決定 3・S2）。検知の
 * 発火ではないため `rule_key` を持たず、送信履歴へ確定しない（仮定 A5）。
 * 予約時刻が今より後なら催促と同じく取り消す対象になる。
 */
export interface ReportPromptReservationRecord {
  kind: "report_prompt";
  /** 予約時刻（ISO8601） */
  scheduledAt: string;
  state: "active" | "pending_cancel";
}

export type AnyReservationRecord = ReservationRecord | ReportPromptReservationRecord;

/**
 * 確定する送信履歴 1 件。`NotificationHistoryEntry`（検知エンジンが読む最小形）
 * に、S2 で `notifications` テーブルへ書くのに要る `ruleType`・`taskId` を
 * 加えたもの（`FiringNotification` からの派生と揃えるため、直接
 * `FiringNotification & NotificationHistoryEntry` としても等価）。
 */
export interface ConfirmedNudge extends NotificationHistoryEntry {
  ruleType: FiringNotification["ruleType"];
  taskId: FiringNotification["taskId"];
}

export interface ReconcileResult<R extends AnyReservationRecord> {
  /** 確定する送信履歴（予約時刻 <= now の催促の控え。state を問わない） */
  toConfirm: ConfirmedNudge[];
  /** `toConfirm` の各要素の元になった控え（同じ順序） */
  confirmedReservations: Extract<R, ReservationRecord>[];
  /** 取り消す予約（予約時刻 > now の控え。種類・state を問わない） */
  toCancel: R[];
  /** 確定せずに消す控え（予約時刻 <= now の固定の通知） */
  toDiscard: Extract<R, ReportPromptReservationRecord>[];
}

function isReportPrompt(
  reservation: AnyReservationRecord,
): reservation is ReportPromptReservationRecord {
  return reservation.kind === "report_prompt";
}

/**
 * 計画し直すたびに最初に行う突き合わせ（機能仕様
 * docs/features/scheduled-nudges.md クリティカル設計決定 2）。予約時刻が
 * `now` 以前の控えは、有効・取り消し待ちを問わず `sent_at` = 予約時刻として
 * 確定する（OS が配信した可能性があるため。取り消し待ちのまま予約時刻を
 * 過ぎた行も同様に確定する）。予約時刻が `now` より後の控えは、有効・
 * 取り消し待ちを問わず取り消す対象として返す（取り消し待ちの行は再試行の
 * 対象になる）。
 * 固定の通知（S2・決定 3）の控えは、予約時刻が `now` 以前なら確定せずに
 * 消す対象（`toDiscard`）、`now` より後なら取り消す対象になる。
 *
 * OS への取り消し実行・控えの行の削除・`notifications` への書き込みは
 * 呼び出し側（S2）の責務。
 */
export function reconcileReservations<R extends AnyReservationRecord>(
  reservations: R[],
  now: Date,
): ReconcileResult<R> {
  const nowMs = now.getTime();
  const toConfirm: ConfirmedNudge[] = [];
  const confirmedReservations: Extract<R, ReservationRecord>[] = [];
  const toCancel: R[] = [];
  const toDiscard: Extract<R, ReportPromptReservationRecord>[] = [];

  for (const reservation of reservations) {
    const scheduledMs = new Date(reservation.scheduledAt).getTime();
    if (scheduledMs > nowMs) {
      toCancel.push(reservation);
    } else if (isReportPrompt(reservation)) {
      toDiscard.push(reservation as Extract<R, ReportPromptReservationRecord>);
    } else {
      confirmedReservations.push(reservation as Extract<R, ReservationRecord>);
      toConfirm.push({
        ruleKey: reservation.ruleKey,
        escalationLevel: reservation.escalationLevel,
        sentAt: reservation.scheduledAt,
        ruleType: reservation.ruleType,
        taskId: reservation.taskId,
      });
    }
  }

  return { toConfirm, confirmedReservations, toCancel, toDiscard };
}
