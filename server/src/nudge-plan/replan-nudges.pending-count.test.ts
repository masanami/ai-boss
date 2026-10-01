import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const { createClaudeClientMock, streamBossMessageMock } = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
  };
});

const { createTestDb } = await import("../db/test-support/create-test-db.js");
const { createNudgeReplanner } = await import("./replan-nudges.js");
const { insertReservation } = await import("./nudge-reservations-repository.js");
const { createFakeSchedulerPort, insertActivityRow, insertSessionRow, insertTaskRow, reservationRows } = await import(
  "./replan-test-fixtures.js"
);

import type { DbPort } from "../db/db-port.js";
import type { FakeSchedulerPort } from "./replan-test-fixtures.js";

/**
 * 切り詰めの検出（機能仕様 docs/features/scheduled-nudges.md 決定 2 の S3 の分・
 * 「S3 の設計」「切り詰めの検出」・受入基準（S3））。OS の予約は模擬のポートで、
 * LLM は模擬で確かめる。時刻はローカル日付で組む（ADR 0007）。
 */

const NOW = new Date(2026, 8, 14, 10, 0); // 月曜 10:00（ローカル）
const MISMATCH_LOG = "nudge replan: the OS pending count differs from the reservations";

interface Harness {
  db: DbPort;
  raw: Database.Database;
  port: FakeSchedulerPort;
}

/** 当日の朝会・夕会は実施済み・09:55 に報告・未着手タスク 1 件（replan-nudges.test.ts と同じ状況） */
async function setup(): Promise<Harness> {
  const { db, raw } = await createTestDb();
  insertSessionRow(raw, "morning", new Date(2026, 8, 14, 9, 0));
  insertSessionRow(raw, "evening", new Date(2026, 8, 14, 9, 1));
  insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 9, 55));
  insertTaskRow(raw, { created_at: new Date(2026, 8, 14, 9, 0).toISOString() });
  return { db, raw, port: createFakeSchedulerPort() };
}

/** 件数を、OS に登録された件数（模擬のポートの `scheduled`）からずらして返すポートにする */
function withCountPending(h: Harness, count: (scheduledSize: number) => Promise<number>) {
  const countPending = vi.fn(() => count(h.port.scheduled.size));
  Object.assign(h.port, { countPending });
  return countPending;
}

async function replan(h: Harness): Promise<void> {
  const replanner = createNudgeReplanner({ db: h.db, env: {}, port: h.port, clock: () => NOW });
  await replanner.requestReplan();
  await replanner.whenIdle();
}

function mismatchLogs(): string[] {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => String(call[0]))
    .filter((message) => message.startsWith(MISMATCH_LOG));
}

function notificationRows(raw: Database.Database): unknown[] {
  return raw.prepare("SELECT * FROM notifications ORDER BY id").all();
}

beforeEach(() => {
  createClaudeClientMock.mockReset();
  streamBossMessageMock.mockReset();
  createClaudeClientMock.mockReturnValue({});
  streamBossMessageMock.mockRejectedValue(new Error("llm down"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("切り詰めの検出（countPending）", () => {
  it("logs a mismatch when the OS has fewer pending notifications than the reservations (OS = rows - 1)", async () => {
    const h = await setup();
    withCountPending(h, async (size) => size - 1);
    await replan(h);
    const rows = reservationRows(h.raw).length;
    expect(rows).toBeGreaterThan(1);
    expect(mismatchLogs()).toEqual([`${MISMATCH_LOG} (os=${rows - 1}, reservations=${rows})`]);
  });

  it("logs a mismatch when the OS has more pending notifications than the reservations (OS = rows + 1)", async () => {
    const h = await setup();
    withCountPending(h, async (size) => size + 1);
    await replan(h);
    const rows = reservationRows(h.raw).length;
    expect(mismatchLogs()).toEqual([`${MISMATCH_LOG} (os=${rows + 1}, reservations=${rows})`]);
  });

  it("counts pending_cancel rows together with active rows", async () => {
    const h = await setup();
    const pendingId = await insertReservation(h.db, {
      reservationKey: "test|pending",
      kind: "nudge",
      scheduledAt: new Date(2026, 8, 14, 20, 0).toISOString(),
      ruleType: "silence",
      ruleKey: "pending",
      escalationLevel: 2,
      taskId: null,
      body: "控えの文面",
      bodySource: "fallback",
      contentKey: "k",
      registeredAt: new Date(2026, 8, 14, 8, 0).toISOString(),
    });
    h.port.scheduled.set(pendingId, { id: pendingId, at: new Date(), title: "", body: "" });
    h.port.failCancel = (id) => id === pendingId;
    withCountPending(h, async (size) => size);
    await replan(h);
    expect(reservationRows(h.raw).some((r) => r.state === "pending_cancel")).toBe(true);
    expect(mismatchLogs()).toEqual([]);
  });

  it("does not log a mismatch when the counts match", async () => {
    const h = await setup();
    const countPending = withCountPending(h, async (size) => size);
    await replan(h);
    expect(countPending).toHaveBeenCalledTimes(1);
    expect(mismatchLogs()).toEqual([]);
  });

  it("calls countPending after all registrations (including the report prompt)", async () => {
    const h = await setup();
    const registeredBeforeCount: number[] = [];
    withCountPending(h, async (size) => {
      registeredBeforeCount.push(h.port.calls.filter((c) => c.op === "register").length);
      return size;
    });
    await replan(h);
    expect(registeredBeforeCount).toEqual([h.port.calls.filter((c) => c.op === "register").length]);
    expect(h.port.scheduled.size).toBe(reservationRows(h.raw).length);
  });

  it("is called even when 64 pending cancellations fill the OS limit and the report prompt is not placed", async () => {
    const h = await setup();
    const pendingIds: number[] = [];
    for (let i = 0; i < 64; i++) {
      const id = await insertReservation(h.db, {
        reservationKey: `test|p${i}`,
        kind: "nudge",
        scheduledAt: new Date(2026, 8, 14, 20 + Math.floor(i / 60), i % 60).toISOString(),
        ruleType: "silence",
        ruleKey: `p${i}`,
        escalationLevel: 2,
        taskId: null,
        body: "控えの文面",
        bodySource: "fallback",
        contentKey: "k",
        registeredAt: new Date(2026, 8, 14, 8, 0).toISOString(),
      });
      pendingIds.push(id);
      h.port.scheduled.set(id, { id, at: new Date(), title: "", body: "" });
    }
    h.port.failCancel = (id) => pendingIds.includes(id);
    const countPending = withCountPending(h, async () => 63);
    await replan(h);
    expect(h.port.calls.filter((c) => c.op === "register")).toHaveLength(0);
    expect(countPending).toHaveBeenCalledTimes(1);
    expect(mismatchLogs()).toEqual([`${MISMATCH_LOG} (os=63, reservations=64)`]);
  });

  it("does not change the reservations or notifications when the counts differ", async () => {
    const same = await setup();
    await replan(same);
    const differing = await setup();
    withCountPending(differing, async (size) => size + 5);
    await replan(differing);
    const strip = (rows: ReturnType<typeof reservationRows>) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")));
    expect(strip(reservationRows(differing.raw))).toEqual(strip(reservationRows(same.raw)));
    expect(notificationRows(differing.raw)).toEqual(notificationRows(same.raw));
    expect(differing.port.calls.map((c) => c.op)).toEqual(same.port.calls.map((c) => c.op));
  });

  it("does not fail the replan when countPending rejects, and logs the failure", async () => {
    const h = await setup();
    withCountPending(h, () => Promise.reject(new Error("get_pending failed")));
    const replanner = createNudgeReplanner({ db: h.db, env: {}, port: h.port, clock: () => NOW });
    await expect(replanner.requestReplan()).resolves.toBeUndefined();
    await replanner.whenIdle();
    expect(reservationRows(h.raw).length).toBe(h.port.scheduled.size);
    expect(mismatchLogs()).toEqual([]);
    expect(vi.mocked(console.error)).toHaveBeenCalledWith("nudge replan: failed to compare the OS pending count:", "Error");
    expect(vi.mocked(console.error)).not.toHaveBeenCalledWith("nudge replan failed:", expect.anything());
  });

  it("still runs the B/C enrichment when countPending rejects", async () => {
    const h = await setup();
    withCountPending(h, () => Promise.reject(new Error("get_pending failed")));
    await replan(h);
    expect(streamBossMessageMock).toHaveBeenCalled();
  });
});
