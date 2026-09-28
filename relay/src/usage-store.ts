/**
 * 利用量のポートとメモリ実装（機能仕様 クリティカル設計決定 4・6、
 * 「機能全体の設計」、#635 のオーナーの決定 2）。
 *
 * S3 で永続化する保存先へ差し替えるため、ポートは非同期の契約にする。
 */

/**
 * 利用量の記録。`units` は原価単位の**整数表現**（原価単位 × 10^10。
 * `usage-metering.ts` の `COST_UNIT_SCALE`）で、予約・上限（`limits`）・`get`
 * の値も同じ整数表現である（浮動小数の足し算で上限の判定を崩さないため）。
 * **これ以外の項目を持たない**（推論内容を入れる場所が無い
 * ことを型で示す。クリティカル設計決定 6）。
 */
export interface UsageRecord {
  accountId: string;
  dayKey: string;
  monthKey: string;
  units: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** 予約。**これ以外の項目を持たない**（クリティカル設計決定 6）。 */
export interface Reservation {
  reservationId: string;
  accountId: string;
  dayKey: string;
  monthKey: string;
  units: number;
  /** 予約の期限の時刻（予約の時刻 ＋ `reservationTtlMs`）。 */
  expiresAt: Date;
}

export interface ReserveRequest {
  accountId: string;
  dayKey: string;
  monthKey: string;
  /** この要求の最大原価（原価単位）。 */
  units: number;
  limits: { daily: number; monthly: number; maxConcurrent: number };
  expiresAt: Date;
}

export type ReserveFailureReason = "daily" | "monthly" | "concurrency";

export type ReserveResult = { ok: true; reservationId: string } | { ok: false; reason: ReserveFailureReason };

/**
 * 精算の結果。
 * - `actual`: 上流の `usage` から求めた実額で記録する
 * - `reserved`: 予約額で確定して記録する（トークン数は 0。課金の有無・額が
 *   確定しないときの安全側）
 * - `release`: 記録せず予約を取り除く（確定的に課金されないとき）
 */
export type SettleOutcome =
  | ({ type: "actual"; units: number } & Omit<UsageRecord, "accountId" | "dayKey" | "monthKey" | "units">)
  | { type: "reserved" }
  | { type: "release" };

export interface UsageSnapshot {
  dayUnits: number;
  monthUnits: number;
  reservedDayUnits: number;
  reservedMonthUnits: number;
  openReservations: number;
}

/**
 * 利用量のポート。
 *
 * **予約（`reserve`）の契約**: そのアカウントの「期間の確定額＋未精算の
 * 予約額の合計＋`units`」が日または月の上限を**超える**なら失敗する（ちょうど
 * 等しいときは成功する）。未精算の予約が `maxConcurrent` 件以上あるときも
 * 失敗する。失敗の理由は、月の上限 → 日の上限 → 同時要求数の順に優先する
 * （両方の金額の上限を超えるときは `monthly`〔仮定 A6〕、金額と同時要求数の
 * 両方なら金額）。判定と予約の追加は、同じアカウントの他の予約・精算と
 * 競合しない 1 つの操作で行う（原子的）。
 *
 * **精算（`settle`）の契約**（#635 のオーナーの決定 2）: 予約は「未精算 →
 * 精算済み」へ**1 回だけ**原子的に遷移する。遷移の時点で予約を取り除き、
 * 結果に応じて予約が保持するアカウント ID・期間キーで記録する（呼び出し側は
 * 期間キーを渡さない）。**すでに精算済み（または存在しない）の予約 ID への
 * `settle` は何もしない（冪等）**——書き込みの確定後にタイムアウトして再試行
 * しても、二重に記録されない。
 *
 * **期限切れの回収**（S3 で作る）も、同じ遷移を `settle(id, { type:
 * "reserved" })` として行う（予約額で確定する）。回収と通常の精算が競合
 * したときは、先に遷移したほうだけが記録され、後の呼び出しは何もしない。
 */
export interface UsageStore {
  reserve(request: ReserveRequest): Promise<ReserveResult>;
  settle(reservationId: string, outcome: SettleOutcome): Promise<void>;
  get(accountId: string, dayKey: string, monthKey: string): Promise<UsageSnapshot>;
}

/** メモリ実装。テストの観測用に、記録と予約の写しを返す `dump` を持つ。 */
export interface MemoryUsageStore extends UsageStore {
  dump(): { records: UsageRecord[]; reservations: Reservation[] };
}

/**
 * 利用量のポートのメモリ実装。**原子性の根拠は JS の単一スレッドの実行**で、
 * `reserve`・`settle` は読み取りから書き込みまでを `await` を挟まない同期の
 * 処理で行う（非同期の契約に合わせて、結果だけを Promise で返す）。
 */
export function createMemoryUsageStore(): MemoryUsageStore {
  const records: UsageRecord[] = [];
  const reservations = new Map<string, Reservation>();
  let nextId = 1;

  function snapshotSync(accountId: string, dayKey: string, monthKey: string): UsageSnapshot {
    const snapshot: UsageSnapshot = {
      dayUnits: 0,
      monthUnits: 0,
      reservedDayUnits: 0,
      reservedMonthUnits: 0,
      openReservations: 0,
    };
    for (const record of records) {
      if (record.accountId !== accountId) continue;
      if (record.dayKey === dayKey) snapshot.dayUnits += record.units;
      if (record.monthKey === monthKey) snapshot.monthUnits += record.units;
    }
    for (const reservation of reservations.values()) {
      if (reservation.accountId !== accountId) continue;
      snapshot.openReservations += 1;
      if (reservation.dayKey === dayKey) snapshot.reservedDayUnits += reservation.units;
      if (reservation.monthKey === monthKey) snapshot.reservedMonthUnits += reservation.units;
    }
    return snapshot;
  }

  function reserveSync(request: ReserveRequest): ReserveResult {
    const current = snapshotSync(request.accountId, request.dayKey, request.monthKey);
    const overMonthly = current.monthUnits + current.reservedMonthUnits + request.units > request.limits.monthly;
    const overDaily = current.dayUnits + current.reservedDayUnits + request.units > request.limits.daily;
    if (overMonthly) return { ok: false, reason: "monthly" };
    if (overDaily) return { ok: false, reason: "daily" };
    if (current.openReservations >= request.limits.maxConcurrent) return { ok: false, reason: "concurrency" };
    const reservationId = `reservation-${nextId++}`;
    reservations.set(reservationId, {
      reservationId,
      accountId: request.accountId,
      dayKey: request.dayKey,
      monthKey: request.monthKey,
      units: request.units,
      expiresAt: new Date(request.expiresAt.getTime()),
    });
    return { ok: true, reservationId };
  }

  function settleSync(reservationId: string, outcome: SettleOutcome): void {
    const reservation = reservations.get(reservationId);
    if (!reservation) {
      // 精算済み・存在しない予約 ID は何もしない（冪等）。
      return;
    }
    reservations.delete(reservationId);
    if (outcome.type === "release") {
      return;
    }
    const base = {
      accountId: reservation.accountId,
      dayKey: reservation.dayKey,
      monthKey: reservation.monthKey,
    };
    if (outcome.type === "reserved") {
      records.push({
        ...base,
        units: reservation.units,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      return;
    }
    records.push({
      ...base,
      units: outcome.units,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadInputTokens: outcome.cacheReadInputTokens,
      cacheCreationInputTokens: outcome.cacheCreationInputTokens,
    });
  }

  return {
    async reserve(request) {
      return reserveSync(request);
    },
    async settle(reservationId, outcome) {
      settleSync(reservationId, outcome);
    },
    async get(accountId, dayKey, monthKey) {
      return snapshotSync(accountId, dayKey, monthKey);
    },
    dump() {
      return {
        records: records.map((record) => ({ ...record })),
        reservations: [...reservations.values()].map((reservation) => ({
          ...reservation,
          expiresAt: new Date(reservation.expiresAt.getTime()),
        })),
      };
    },
  };
}
