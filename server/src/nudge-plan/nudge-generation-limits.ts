import type { Db } from "../db/db-port.js";
import { startOfLocalDayIso } from "../activity/local-day.js";

/** 生成の種類: 予約 1 件ごとの個別生成（B）・人格設定ごとの文面セット（C） */
export type GenerationKind = "individual" | "message_set";

export interface GenerationLimit {
  /** 直前 60 分の上限。無ければ 1 時間の枠を持たない */
  perHour: number | null;
  /** 1 ローカル暦日の上限 */
  perDay: number;
}

/** 機能仕様 docs/features/scheduled-nudges.md 決定 4（推奨値・仮定 A6） */
export const GENERATION_LIMITS: Record<GenerationKind, GenerationLimit> = {
  individual: { perHour: 12, perDay: 60 },
  message_set: { perHour: null, perDay: 3 },
};

const HOUR_MS = 60 * 60 * 1000;
/** これより古い試行の記録は枠に入りえないため消す（1 日の枠 ＋ 余裕） */
const ATTEMPT_RETENTION_MS = 48 * HOUR_MS;

async function countAttemptsSince(db: Db, kind: GenerationKind, sinceIso: string): Promise<number> {
  const row = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM nudge_generation_attempts WHERE kind = ? AND attempted_at >= ?",
    [kind, sinceIso],
  );
  return row?.count ?? 0;
}

/**
 * 生成の試行を 1 回分予約する（機能仕様「上限の迂回経路と塞ぎ方」）。枠に
 * 空きがあれば試行を記録して `true`、無ければ記録せず `false`。
 *
 * - 数え上げと記録を 1 つのトランザクションで行う（同時に求められても、
 *   枠を超えて記録しない）。
 * - LLM を呼ぶ前に記録するため、失敗した生成も 1 回に数える。
 * - 枠は開始だけを区切り、終わりを区切らない（時計を戻しても、今より後の
 *   時刻の試行を数え続ける）。1 日の枠はローカル暦日の 0 時で区切る。
 * - DB に記録するため、アプリを再起動しても数え直さない。
 */
export async function tryReserveGenerationAttempt(
  db: Db,
  kind: GenerationKind,
  now: Date,
): Promise<boolean> {
  const limit = GENERATION_LIMITS[kind];
  return db.transaction(async (tx) => {
    if ((await countAttemptsSince(tx, kind, startOfLocalDayIso(now))) >= limit.perDay) {
      return false;
    }
    if (
      limit.perHour !== null &&
      (await countAttemptsSince(tx, kind, new Date(now.getTime() - HOUR_MS).toISOString())) >= limit.perHour
    ) {
      return false;
    }
    await tx.run("DELETE FROM nudge_generation_attempts WHERE attempted_at < ?", [
      new Date(now.getTime() - ATTEMPT_RETENTION_MS).toISOString(),
    ]);
    await tx.run("INSERT INTO nudge_generation_attempts (kind, attempted_at) VALUES (?, ?)", [
      kind,
      now.toISOString(),
    ]);
    return true;
  });
}
