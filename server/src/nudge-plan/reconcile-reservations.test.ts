import { describe, expect, it } from "vitest";
import { reconcileReservations, type ReservationRecord } from "./reconcile-reservations.js";

function makeReservation(overrides: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    scheduledAt: new Date(2026, 8, 14, 10, 0).toISOString(),
    ruleType: "unstarted",
    ruleKey: "unstarted:1",
    escalationLevel: 1,
    taskId: 1,
    state: "active",
    ...overrides,
  };
}

describe("reconcileReservations", () => {
  it("confirms an active reservation whose scheduled time is before now, with sentAt = the scheduled time", () => {
    const now = new Date(2026, 8, 14, 10, 5);
    const reservation = makeReservation({
      scheduledAt: new Date(2026, 8, 14, 10, 0).toISOString(),
      state: "active",
    });

    const { toConfirm, toCancel } = reconcileReservations([reservation], now);

    expect(toConfirm).toEqual([
      {
        ruleKey: "unstarted:1",
        escalationLevel: 1,
        sentAt: reservation.scheduledAt,
        ruleType: "unstarted",
        taskId: 1,
      },
    ]);
    expect(toCancel).toEqual([]);
  });

  it("confirms an active reservation whose scheduled time is exactly now", () => {
    const now = new Date(2026, 8, 14, 10, 0);
    const reservation = makeReservation({ scheduledAt: now.toISOString(), state: "active" });

    const { toConfirm, toCancel } = reconcileReservations([reservation], now);

    expect(toConfirm).toHaveLength(1);
    expect(toConfirm[0]?.sentAt).toBe(reservation.scheduledAt);
    expect(toCancel).toEqual([]);
  });

  it("cancels an active reservation whose scheduled time is after now and does not confirm it", () => {
    const now = new Date(2026, 8, 14, 10, 0);
    const reservation = makeReservation({
      scheduledAt: new Date(2026, 8, 14, 10, 0, 0, 1).toISOString(), // now + 1ms
      state: "active",
    });

    const { toConfirm, toCancel } = reconcileReservations([reservation], now);

    expect(toConfirm).toEqual([]);
    expect(toCancel).toEqual([reservation]);
  });

  it("confirms a pending_cancel reservation whose scheduled time is before now, the same as an active one", () => {
    const now = new Date(2026, 8, 14, 10, 5);
    const reservation = makeReservation({
      scheduledAt: new Date(2026, 8, 14, 10, 0).toISOString(),
      state: "pending_cancel",
    });

    const { toConfirm, toCancel } = reconcileReservations([reservation], now);

    expect(toConfirm).toEqual([
      {
        ruleKey: reservation.ruleKey,
        escalationLevel: reservation.escalationLevel,
        sentAt: reservation.scheduledAt,
        ruleType: reservation.ruleType,
        taskId: reservation.taskId,
      },
    ]);
    expect(toCancel).toEqual([]);
  });

  it("returns a pending_cancel reservation whose scheduled time is after now as a cancellation retry target", () => {
    const now = new Date(2026, 8, 14, 10, 0);
    const reservation = makeReservation({
      scheduledAt: new Date(2026, 8, 14, 10, 1).toISOString(),
      state: "pending_cancel",
    });

    const { toConfirm, toCancel } = reconcileReservations([reservation], now);

    expect(toConfirm).toEqual([]);
    expect(toCancel).toEqual([reservation]);
  });

  it("classifies a mix of reservations independently, preserving extra fields via the generic", () => {
    interface ReservationWithId extends ReservationRecord {
      reservationId: string;
    }
    const now = new Date(2026, 8, 14, 10, 0);
    const past: ReservationWithId = {
      ...makeReservation({ scheduledAt: new Date(2026, 8, 14, 9, 0).toISOString(), state: "active" }),
      reservationId: "res-past",
    };
    const future: ReservationWithId = {
      ...makeReservation({ scheduledAt: new Date(2026, 8, 14, 11, 0).toISOString(), state: "active" }),
      reservationId: "res-future",
    };
    const pastPendingCancel: ReservationWithId = {
      ...makeReservation({ scheduledAt: new Date(2026, 8, 14, 9, 30).toISOString(), state: "pending_cancel" }),
      reservationId: "res-past-pending",
    };
    const futurePendingCancel: ReservationWithId = {
      ...makeReservation({ scheduledAt: new Date(2026, 8, 14, 11, 30).toISOString(), state: "pending_cancel" }),
      reservationId: "res-future-pending",
    };

    const { toConfirm, toCancel } = reconcileReservations(
      [past, future, pastPendingCancel, futurePendingCancel],
      now,
    );

    expect(toConfirm.map((c) => c.sentAt)).toEqual([past.scheduledAt, pastPendingCancel.scheduledAt]);
    expect(toCancel).toEqual([future, futurePendingCancel]);
    // ジェネリクスにより呼び出し側の追加フィールドが保たれる
    expect(toCancel[0]?.reservationId).toBe("res-future");
  });

  describe("report-prompt reservations (S2)", () => {
    const now = new Date(2026, 8, 14, 10, 0);
    const report = (scheduledAt: Date, state: "active" | "pending_cancel" = "active") => ({
      kind: "report_prompt" as const,
      scheduledAt: scheduledAt.toISOString(),
      state,
    });

    it("discards a past report prompt without confirming it", () => {
      const past = report(new Date(2026, 8, 14, 9, 0));
      const result = reconcileReservations([past], now);
      expect(result.toConfirm).toEqual([]);
      expect(result.toDiscard).toEqual([past]);
      expect(result.toCancel).toEqual([]);
    });

    it("cancels a future report prompt (active or pending_cancel)", () => {
      const future = report(new Date(2026, 8, 14, 11, 0));
      const pending = report(new Date(2026, 8, 14, 12, 0), "pending_cancel");
      const result = reconcileReservations([future, pending], now);
      expect(result.toCancel).toEqual([future, pending]);
      expect(result.toDiscard).toEqual([]);
    });

    it("returns the source reservation of each confirmed entry in the same order", () => {
      const a = makeReservation({ scheduledAt: new Date(2026, 8, 14, 9, 0).toISOString(), ruleKey: "a" });
      const b = makeReservation({ scheduledAt: new Date(2026, 8, 14, 9, 30).toISOString(), ruleKey: "b" });
      const result = reconcileReservations([a, report(new Date(2026, 8, 14, 9, 10)), b], now);
      expect(result.confirmedReservations).toEqual([a, b]);
      expect(result.toConfirm.map((c) => c.ruleKey)).toEqual(["a", "b"]);
    });
  });
});

