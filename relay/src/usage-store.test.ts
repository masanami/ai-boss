import { describe, expect, it } from "vitest";
import { createMemoryUsageStore, type ReserveRequest, type SettleOutcome } from "./usage-store.js";

/**
 * 利用量のポートのメモリ実装の契約（クリティカル設計決定 4・6、#635 の
 * オーナーの決定 2: 精算は「未精算 → 精算済み」の 1 回だけの遷移で冪等）。
 */

function reserveRequest(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    accountId: "account-a",
    dayKey: "2026-09-15",
    monthKey: "2026-09",
    units: 1,
    limits: { daily: 100, monthly: 1000, maxConcurrent: 100 },
    expiresAt: new Date("2026-09-15T12:10:00Z"),
    ...overrides,
  };
}

const ACTUAL: SettleOutcome = {
  type: "actual",
  units: 25,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
};

async function reserveOk(store: ReturnType<typeof createMemoryUsageStore>, overrides: Partial<ReserveRequest> = {}) {
  const result = await store.reserve(reserveRequest(overrides));
  if (!result.ok) throw new Error(`reserve failed: ${result.reason}`);
  return result.reservationId;
}

describe("予約", () => {
  it("同じアカウントの予約を 100 件同時に呼ぶと、成功した予約の額の合計は dailyLimit を超えない", async () => {
    const store = createMemoryUsageStore();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.reserve(reserveRequest({ units: 3, limits: { daily: 50, monthly: 1000, maxConcurrent: 1000 } }))),
    );
    const succeeded = results.filter((result) => result.ok).length;
    expect(succeeded * 3).toBeLessThanOrEqual(50);
    expect(succeeded).toBe(16);
  });

  it("合計がちょうど上限に等しい予約は成功し、超える予約は失敗する", async () => {
    const store = createMemoryUsageStore();
    const limits = { daily: 2, monthly: 1000, maxConcurrent: 10 };
    expect((await store.reserve(reserveRequest({ units: 1, limits }))).ok).toBe(true);
    expect((await store.reserve(reserveRequest({ units: 1, limits }))).ok).toBe(true);
    expect(await store.reserve(reserveRequest({ units: 1, limits }))).toEqual({ ok: false, reason: "daily" });
  });

  it("未精算の予約が maxConcurrent 件あると concurrency で失敗し、1 件精算すると成功する", async () => {
    const store = createMemoryUsageStore();
    const limits = { daily: 100, monthly: 1000, maxConcurrent: 2 };
    const first = await reserveOk(store, { limits });
    await reserveOk(store, { limits });
    expect(await store.reserve(reserveRequest({ limits }))).toEqual({ ok: false, reason: "concurrency" });
    await store.settle(first, { type: "release" });
    expect((await store.reserve(reserveRequest({ limits }))).ok).toBe(true);
  });

  it("失敗の理由は monthly → daily → concurrency の順に優先する", async () => {
    const store = createMemoryUsageStore();
    await reserveOk(store, { limits: { daily: 100, monthly: 100, maxConcurrent: 1 } });
    expect(await store.reserve(reserveRequest({ units: 200, limits: { daily: 100, monthly: 100, maxConcurrent: 1 } }))).toEqual({
      ok: false,
      reason: "monthly",
    });
    expect(await store.reserve(reserveRequest({ units: 200, limits: { daily: 100, monthly: 1000, maxConcurrent: 1 } }))).toEqual({
      ok: false,
      reason: "daily",
    });
  });

  it("確定額は同じ期間キーの分だけを数える（前日の確定額は今日の判定に入らない）", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store, { units: 90, dayKey: "2026-09-14" });
    await store.settle(id, { type: "reserved" });
    expect((await store.reserve(reserveRequest({ units: 90 }))).ok).toBe(true);
    expect(await store.reserve(reserveRequest({ units: 11 }))).toEqual({ ok: false, reason: "daily" });
  });

  it("予約の項目は予約 ID・アカウント ID・日と月の期間キー・原価単位・期限だけ", async () => {
    const store = createMemoryUsageStore();
    await reserveOk(store);
    expect(Object.keys(store.dump().reservations[0]).sort()).toEqual(
      ["accountId", "dayKey", "expiresAt", "monthKey", "reservationId", "units"].sort(),
    );
  });
});

describe("精算", () => {
  it("actual は予約が保持するアカウント ID・期間キーで実額を記録し、予約を取り除く", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store);
    await store.settle(id, ACTUAL);
    const { records, reservations } = store.dump();
    expect(reservations).toEqual([]);
    expect(records).toEqual([
      {
        accountId: "account-a",
        dayKey: "2026-09-15",
        monthKey: "2026-09",
        units: 25,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    ]);
  });

  it("reserved は予約額を記録し、トークン数は 0", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store, { units: 7 });
    await store.settle(id, { type: "reserved" });
    expect(store.dump().records).toEqual([
      expect.objectContaining({ units: 7, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }),
    ]);
  });

  it("release は記録せずに予約を取り除く", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store);
    await store.settle(id, { type: "release" });
    expect(store.dump()).toEqual({ records: [], reservations: [] });
  });

  it("記録の項目はアカウント ID・日と月の期間キー・原価単位・4 種のトークン数だけ", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store);
    await store.settle(id, { ...ACTUAL, text: "should not be stored" } as SettleOutcome);
    expect(Object.keys(store.dump().records[0]).sort()).toEqual(
      [
        "accountId",
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "dayKey",
        "inputTokens",
        "monthKey",
        "outputTokens",
        "units",
      ].sort(),
    );
  });

  describe("冪等性（1 回だけの遷移）", () => {
    it("同じ予約 ID を 2 回精算しても、記録は 1 件（再試行で二重に記録しない）", async () => {
      const store = createMemoryUsageStore();
      const id = await reserveOk(store);
      await store.settle(id, ACTUAL);
      await store.settle(id, ACTUAL);
      expect(store.dump().records).toHaveLength(1);
      expect((await store.get("account-a", "2026-09-15", "2026-09")).dayUnits).toBe(25);
    });

    it("精算済みの予約 ID に別の結果で精算しても、最初の結果が残る", async () => {
      const store = createMemoryUsageStore();
      const id = await reserveOk(store, { units: 7 });
      await store.settle(id, { type: "release" });
      await store.settle(id, { type: "reserved" });
      await store.settle(id, ACTUAL);
      expect(store.dump()).toEqual({ records: [], reservations: [] });
    });

    it("期限切れの回収（reserved）と通常の精算（actual）が競合しても、先に遷移したほうだけが記録される", async () => {
      for (const order of [
        [ACTUAL, { type: "reserved" }],
        [{ type: "reserved" }, ACTUAL],
      ] as Array<[SettleOutcome, SettleOutcome]>) {
        const store = createMemoryUsageStore();
        const id = await reserveOk(store, { units: 7 });
        await Promise.all([store.settle(id, order[0]), store.settle(id, order[1])]);
        const { records, reservations } = store.dump();
        expect(reservations).toEqual([]);
        expect(records).toHaveLength(1);
        expect(records[0].units).toBe(order[0].type === "actual" ? 25 : 7);
      }
    });

    it("存在しない予約 ID の精算は何もしない", async () => {
      const store = createMemoryUsageStore();
      await reserveOk(store);
      await store.settle("reservation-unknown", ACTUAL);
      expect(store.dump().records).toEqual([]);
      expect(store.dump().reservations).toHaveLength(1);
    });
  });
});

describe("get", () => {
  it("確定額・未精算の予約額・予約の件数を期間ごとに返す", async () => {
    const store = createMemoryUsageStore();
    const id = await reserveOk(store, { units: 2 });
    await reserveOk(store, { units: 5 });
    await reserveOk(store, { units: 11, accountId: "account-b" });
    await store.settle(id, { type: "reserved" });
    expect(await store.get("account-a", "2026-09-15", "2026-09")).toEqual({
      dayUnits: 2,
      monthUnits: 2,
      reservedDayUnits: 5,
      reservedMonthUnits: 5,
      openReservations: 1,
    });
    expect(await store.get("account-a", "2026-09-16", "2026-09")).toMatchObject({ dayUnits: 0, monthUnits: 2 });
  });
});
