import type { Db } from "../db/db-port.js";
import type { DetectionRuleType } from "../detection/detection-types.js";
import { insertScheduledNotification } from "../notifications/notifications-repository.js";
import type { AnyReservationRecord } from "./reconcile-reservations.js";

export type ReservationKind = "nudge" | "report_prompt";
export type ReservationState = "active" | "pending_cancel";
/**
 * 文面の出どころ（機能仕様 決定 4 の順序）: 個別生成（B）・文面セット（C）・
 * 固定文（`FALLBACK_TEMPLATES`）・固定の「アプリを開いて報告しろ」通知。
 */
export type ReservationBodySource = "individual" | "message_set" | "fallback" | "report_prompt";

/** `nudge_reservations` の行（server/src/db/migrate.ts v11） */
export interface NudgeReservationRow {
  id: number;
  reservation_key: string;
  kind: ReservationKind;
  state: ReservationState;
  scheduled_at: string;
  rule_type: string | null;
  rule_key: string | null;
  escalation_level: number | null;
  task_id: number | null;
  body: string;
  body_source: ReservationBodySource;
  content_key: string | null;
  registered_at: string;
}

/** 控えの行 ＋ 突き合わせ（`reconcileReservations`）が読む形 */
export type StoredReservation = AnyReservationRecord & { row: NudgeReservationRow };

export interface NewReservation {
  reservationKey: string;
  kind: ReservationKind;
  scheduledAt: string;
  ruleType: DetectionRuleType | null;
  ruleKey: string | null;
  escalationLevel: number | null;
  taskId: number | null;
  body: string;
  bodySource: ReservationBodySource;
  contentKey: string | null;
  registeredAt: string;
}

export async function listReservations(db: Db): Promise<StoredReservation[]> {
  const rows = await db.all<NudgeReservationRow>(
    "SELECT * FROM nudge_reservations ORDER BY scheduled_at ASC, id ASC",
  );
  return rows.map(toStoredReservation);
}

function toStoredReservation(row: NudgeReservationRow): StoredReservation {
  if (row.kind === "report_prompt") {
    return { kind: "report_prompt", scheduledAt: row.scheduled_at, state: row.state, row };
  }
  return {
    kind: "nudge",
    scheduledAt: row.scheduled_at,
    state: row.state,
    // 催促の行は migrate.ts の書き手（insertReservation）が必ず埋める。
    ruleType: row.rule_type as DetectionRuleType,
    ruleKey: row.rule_key ?? "",
    escalationLevel: row.escalation_level ?? 0,
    taskId: row.task_id,
    row,
  };
}

export async function findReservationByKey(
  db: Db,
  reservationKey: string,
): Promise<NudgeReservationRow | undefined> {
  return db.get<NudgeReservationRow>(
    "SELECT * FROM nudge_reservations WHERE reservation_key = ?",
    [reservationKey],
  );
}

/** 控えの行を書き、OS へ渡す ID（行の ID）を返す */
export async function insertReservation(db: Db, reservation: NewReservation): Promise<number> {
  const result = await db.run(
    `INSERT INTO nudge_reservations (
       reservation_key, kind, state, scheduled_at, rule_type, rule_key,
       escalation_level, task_id, body, body_source, content_key, registered_at
     ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reservation.reservationKey,
      reservation.kind,
      reservation.scheduledAt,
      reservation.ruleType,
      reservation.ruleKey,
      reservation.escalationLevel,
      reservation.taskId,
      reservation.body,
      reservation.bodySource,
      reservation.contentKey,
      reservation.registeredAt,
    ],
  );
  return Number(result.lastInsertRowid);
}

export async function deleteReservation(db: Db, id: number): Promise<void> {
  await db.run("DELETE FROM nudge_reservations WHERE id = ?", [id]);
}

export async function setReservationState(db: Db, id: number, state: ReservationState): Promise<void> {
  await db.run("UPDATE nudge_reservations SET state = ? WHERE id = ?", [state, id]);
}

export async function updateReservationBody(
  db: Db,
  id: number,
  body: string,
  bodySource: ReservationBodySource,
): Promise<void> {
  await db.run("UPDATE nudge_reservations SET body = ?, body_source = ? WHERE id = ?", [
    body,
    bodySource,
    id,
  ]);
}

/**
 * OS からは取り消せたが控えの削除だけ失敗した行（`canceledInOs`）を、
 * 新しい計画の文面で登録し直した後に有効へ戻す（機能仕様 決定 2・仮定
 * A22）。控えの文面・出どころ・使い回しのキーも新しい計画の値に合わせる
 * （古いままだと `swapToIndividual` の `content_key` 判定が食い違い、B への
 * 差し替えが止まりうるため）。
 */
export async function reactivateReservationWithNewBody(
  db: Db,
  id: number,
  reservation: Pick<NewReservation, "body" | "bodySource" | "contentKey" | "registeredAt">,
): Promise<void> {
  await db.run(
    `UPDATE nudge_reservations
       SET state = 'active', body = ?, body_source = ?, content_key = ?, registered_at = ?
     WHERE id = ?`,
    [reservation.body, reservation.bodySource, reservation.contentKey, reservation.registeredAt, id],
  );
}

/**
 * 突き合わせの結果を DB へ反映する（機能仕様 決定 2）。予約時刻を過ぎた
 * 催促の控えを `sent_at` ＝ 予約時刻で `notifications` へ確定し、確定した
 * 行と確定しない固定の通知の行を消す。確定と削除を 1 つのトランザクション
 * で行い、同じ控えが 2 回確定されないようにする。
 */
export async function confirmAndRemoveReservations(
  db: Db,
  confirmed: StoredReservation[],
  discarded: StoredReservation[],
): Promise<void> {
  if (confirmed.length === 0 && discarded.length === 0) return;
  await db.transaction(async (tx) => {
    for (const { row } of confirmed) {
      await insertScheduledNotification(tx, {
        type: row.rule_type ?? "",
        rule_key: row.rule_key,
        escalation_level: row.escalation_level,
        body: row.body,
        sent_at: row.scheduled_at,
      });
      await deleteReservation(tx, row.id);
    }
    for (const { row } of discarded) {
      await deleteReservation(tx, row.id);
    }
  });
}
