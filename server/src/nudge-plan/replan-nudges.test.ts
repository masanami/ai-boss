import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";

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
const {
  createNudgeReplanner,
  REPORT_PROMPT_BODY,
  PLAN_HORIZON_MS,
  messageSetPersonaKey,
  individualContentKey,
} = await import("./replan-nudges.js");
const { insertReservation } = await import("./nudge-reservations-repository.js");
const { saveMessageSet } = await import("./nudge-bodies-repository.js");
const { parseMessageSet } = await import("./nudge-message-set.js");
const { calculateTodayMaxEscalationLevel } = await import("../dashboard/today-escalation.js");
const { generateNotificationBody, buildNotificationLlmRequest, buildFallbackBody } = await import(
  "../notifications/notification-body.js"
);
const { DEFAULT_PERSONA_SETTINGS } = await import("../boss/persona-prompt.js");
const { setLlmSelectionResolver, resetLlmSelectionResolverForTest } = await import("../llm/llm-selection.js");
const { evaluateRules } = await import("../detection/rule-engine.js");
const { DEFAULT_DETECTION_SETTINGS } = await import("../detection/detection-types.js");
const {
  createFakeSchedulerPort,
  insertActivityRow,
  insertSessionRow,
  insertTaskRow,
  putSettingRow,
  reservationRows,
  validMessageSetJson,
} = await import("./replan-test-fixtures.js");

import type { DbPort } from "../db/db-port.js";
import type { ClaudeMessageRequest } from "../llm/claude-client.js";
import type { FakeSchedulerPort } from "./replan-test-fixtures.js";
import type { NotificationHistoryEntry } from "../detection/detection-types.js";
import type { Task } from "../tasks/task.js";
import type { NotificationBodyRequest } from "../notifications/notification-body.js";

const NOW = new Date(2026, 8, 14, 10, 0); // 月曜 10:00（ローカル）
const B_MAX_TOKENS = 150;

function textMessage(text: string): Anthropic.Message {
  return { content: text ? [{ type: "text", text, citations: null }] : [] } as unknown as Anthropic.Message;
}

function isIndividualRequest(request: ClaudeMessageRequest): boolean {
  return request.maxTokens === B_MAX_TOKENS;
}

function llmRequests(): ClaudeMessageRequest[] {
  return streamBossMessageMock.mock.calls.map((call) => call[1] as ClaudeMessageRequest);
}

function requestText(request: ClaudeMessageRequest): string {
  return `${String(request.system)}\n${JSON.stringify(request.messages)}`;
}

/** LLM の模擬: B は「B:<予約時刻の分>」、C は正しい形の文面セットを返す */
function llmSucceeds(): void {
  streamBossMessageMock.mockImplementation(async (_client: unknown, request: ClaudeMessageRequest) => {
    if (isIndividualRequest(request)) {
      const match = /現在日時: \S+（.）(\d\d:\d\d)/.exec(String(request.system));
      return textMessage(`B:${match?.[1] ?? "?"}`);
    }
    return textMessage(JSON.stringify(validMessageSetJson("C:{task}/{time}")));
  });
}

function llmFails(): void {
  streamBossMessageMock.mockRejectedValue(new Error("llm down"));
}

interface Harness {
  db: DbPort;
  raw: Database.Database;
  port: FakeSchedulerPort;
  clock: { now: Date };
  taskId: number;
}

/**
 * 基本の状況: 当日の朝会・夕会は実施済み、09:55 に報告、最優先の未着手タスク
 * 1 件（09:00 作成）。10:00 に計画すると、当日は未着手（10:00 L1・10:15 L2・
 * 10:25 L3 …）と無音（10:40 L1 …）、翌日は 09:00 から朝会などが予約される。
 */
async function setup(options: { replacesSameId?: boolean } = {}): Promise<Harness> {
  const { db, raw } = await createTestDb();
  insertSessionRow(raw, "morning", new Date(2026, 8, 14, 9, 0));
  insertSessionRow(raw, "evening", new Date(2026, 8, 14, 9, 1));
  insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 9, 55));
  const taskId = insertTaskRow(raw, { created_at: new Date(2026, 8, 14, 9, 0).toISOString() });
  return { db, raw, port: createFakeSchedulerPort(options.replacesSameId ?? true), clock: { now: NOW }, taskId };
}

function replannerFor(h: Harness) {
  return createNudgeReplanner({ db: h.db, env: {}, port: h.port, clock: () => h.clock.now });
}

async function replan(h: Harness): Promise<void> {
  const replanner = replannerFor(h);
  await replanner.requestReplan();
  await replanner.whenIdle();
}

function notificationRows(raw: Database.Database) {
  return raw.prepare("SELECT * FROM notifications ORDER BY sent_at ASC, id ASC").all() as Array<{
    type: string;
    rule_key: string | null;
    escalation_level: number | null;
    body: string;
    sent_at: string;
    delivered: number | null;
    channel: string | null;
  }>;
}

function at(hour: number, minute: number, day = 14): string {
  return new Date(2026, 8, day, hour, minute).toISOString();
}

async function insertNudgeRow(
  h: Harness,
  overrides: { scheduledAt: string; state?: "active" | "pending_cancel"; ruleKey?: string; level?: number; body?: string },
): Promise<number> {
  const id = await insertReservation(h.db, {
    reservationKey: `test|${overrides.ruleKey ?? "silence"}|${overrides.scheduledAt}`,
    kind: "nudge",
    scheduledAt: overrides.scheduledAt,
    ruleType: "silence",
    ruleKey: overrides.ruleKey ?? "silence",
    escalationLevel: overrides.level ?? 2,
    taskId: null,
    body: overrides.body ?? "控えの文面",
    bodySource: "fallback",
    contentKey: "k",
    registeredAt: at(8, 0),
  });
  if (overrides.state === "pending_cancel") {
    h.raw.prepare("UPDATE nudge_reservations SET state = 'pending_cancel' WHERE id = ?").run(id);
  }
  return id;
}

/** 書き込みの SQL が条件に合うときだけ失敗する DB（控えの更新・削除の失敗を起こす） */
function failingWrites(
  db: DbPort,
  shouldFail: (sql: string, params: readonly unknown[] | undefined) => boolean,
): DbPort {
  return {
    run: (sql, params) =>
      shouldFail(sql, params) ? Promise.reject(new Error("db write failed")) : db.run(sql, params),
    get: (sql, params) => db.get(sql, params),
    all: (sql, params) => db.all(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
  };
}

const UPDATE_BODY_SQL = "UPDATE nudge_reservations SET body";
const DELETE_RESERVATION_SQL = "DELETE FROM nudge_reservations WHERE id";
// `updateReservationBody`（`SET body = ?, body_source = ?`）とは書き出しが
// 違う（`reactivateReservationWithNewBody` は `SET state = 'active', body = ?...`）
// ため、この prefix は `setReservationState` の呼び出しだけに一致する。
const SET_PENDING_CANCEL_SQL = "UPDATE nudge_reservations SET state = ?";

/** 特定の行 ID への削除だけ失敗する DB（他の行の確定・取り消しは通す） */
function failingDeleteForId(db: DbPort, id: number): DbPort {
  return failingWrites(db, (sql, params) => sql.startsWith(DELETE_RESERVATION_SQL) && params?.[0] === id);
}

function insertEvidenceRow(raw: Database.Database, taskId: number): void {
  raw
    .prepare("INSERT INTO task_evidences (task_id, kind, url, created_at) VALUES (?, 'link', 'https://example.com/e', ?)")
    .run(taskId, at(9, 30));
}

beforeEach(() => {
  createClaudeClientMock.mockReset();
  streamBossMessageMock.mockReset();
  createClaudeClientMock.mockReturnValue({});
  llmFails();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("控えと確定", () => {
  it("confirms a past nudge reservation into notifications with sent_at = the scheduled time", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 30) });
    await replan(h);
    const rows = notificationRows(h.raw).filter((r) => r.sent_at === at(9, 30));
    expect(rows).toHaveLength(1);
  });

  it("copies rule_key, level and type from the reservation", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 30), ruleKey: "silence", level: 2 });
    await replan(h);
    const [row] = notificationRows(h.raw);
    expect(row).toMatchObject({ rule_key: "silence", escalation_level: 2, type: "silence" });
  });

  it("copies the registered body from the reservation", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 30), body: "資料作成を今すぐやれ" });
    await replan(h);
    expect(notificationRows(h.raw)[0]?.body).toBe("資料作成を今すぐやれ");
  });

  it("writes delivered = NULL and channel = 'scheduled'", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 30) });
    await replan(h);
    expect(notificationRows(h.raw)[0]).toMatchObject({ delivered: null, channel: "scheduled" });
  });

  it("removes the confirmed reservation so a second replan does not confirm it again", async () => {
    const h = await setup();
    const id = await insertNudgeRow(h, { scheduledAt: at(9, 30) });
    await replan(h);
    await replan(h);
    expect(reservationRows(h.raw).some((r) => r.id === id)).toBe(false);
    expect(notificationRows(h.raw).filter((r) => r.sent_at === at(9, 30))).toHaveLength(1);
  });

  it("discards a past report-prompt reservation without confirming it", async () => {
    const h = await setup();
    const id = await insertReservation(h.db, {
      reservationKey: "report_prompt|past",
      kind: "report_prompt",
      scheduledAt: at(9, 30),
      ruleType: null,
      ruleKey: null,
      escalationLevel: null,
      taskId: null,
      body: REPORT_PROMPT_BODY,
      bodySource: "report_prompt",
      contentKey: null,
      registeredAt: at(8, 0),
    });
    await replan(h);
    expect(notificationRows(h.raw)).toHaveLength(0);
    expect(reservationRows(h.raw).some((r) => r.id === id)).toBe(false);
  });

  it("removes a future reservation once the OS cancellation succeeds", async () => {
    const h = await setup();
    const id = await insertNudgeRow(h, { scheduledAt: at(12, 0, 15) });
    await replan(h);
    expect(h.port.calls).toContainEqual({ op: "cancel", id });
    expect(reservationRows(h.raw).some((r) => r.id === id)).toBe(false);
  });

  it("keeps a reservation whose OS cancellation failed, as pending_cancel", async () => {
    const h = await setup();
    const id = await insertNudgeRow(h, { scheduledAt: at(12, 0, 15) });
    h.port.failCancel = (cancelId) => cancelId === id;
    await replan(h);
    expect(reservationRows(h.raw).find((r) => r.id === id)?.state).toBe("pending_cancel");
  });

  it("retries the cancellation of a pending_cancel reservation on the next replan", async () => {
    const h = await setup();
    const id = await insertNudgeRow(h, { scheduledAt: at(12, 0, 15), state: "pending_cancel" });
    await replan(h);
    expect(h.port.calls).toContainEqual({ op: "cancel", id });
    expect(reservationRows(h.raw).some((r) => r.id === id)).toBe(false);
  });

  it("confirms a pending_cancel reservation whose scheduled time has passed", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 40), state: "pending_cancel" });
    await replan(h);
    expect(notificationRows(h.raw).map((r) => r.sent_at)).toContain(at(9, 40));
  });

  it("reactivates a pending_cancel reservation that the new plan contains, without registering it again", async () => {
    const h = await setup();
    await replan(h);
    const target = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 40));
    expect(target).toBeDefined();
    h.port.failCancel = (id) => id === target!.id;
    h.port.calls = [];
    await replan(h);
    const after = reservationRows(h.raw).filter((r) => r.reservation_key === target!.reservation_key);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: target!.id, state: "active" });
    expect(h.port.calls.filter((c) => c.op === "register" && c.id === target!.id)).toHaveLength(0);
  });

  it("re-registers a reservation that was cancelled in the OS but whose row could not be removed, when the new plan contains it", async () => {
    const h = await setup();
    await replan(h);
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(DELETE_RESERVATION_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    await replanner.whenIdle();
    const rows = reservationRows(h.raw);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.state).toBe("active");
      expect(h.port.scheduled.get(row.id)).toMatchObject({ body: row.body, at: new Date(row.scheduled_at) });
    }
  });

  it("does not keep a reservation whose OS registration failed", async () => {
    const h = await setup();
    h.port.failRegister = (request) => request.at.getTime() === new Date(at(10, 40)).getTime();
    await replan(h);
    expect(reservationRows(h.raw).some((r) => r.scheduled_at === at(10, 40))).toBe(false);
    expect(reservationRows(h.raw).length).toBeGreaterThan(0);
  });

  describe("the OS reservation count", () => {
    /** 朝会・夕会が未実施の日の 09:00 に計画すると 24 時間で 63 件を超える（仕様の実測） */
    async function denseSetup(): Promise<Harness> {
      const { db, raw } = await createTestDb();
      insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 8, 50));
      const taskId = insertTaskRow(raw, { created_at: new Date(2026, 8, 14, 8, 0).toISOString() });
      return { db, raw, port: createFakeSchedulerPort(), clock: { now: new Date(2026, 8, 14, 9, 0) }, taskId };
    }

    it("is exactly 64 (63 nudges + 1 report prompt) when the plan is truncated with no pending cancellations", async () => {
      const h = await denseSetup();
      await replan(h);
      const rows = reservationRows(h.raw);
      expect(rows.filter((r) => r.kind === "nudge")).toHaveLength(63);
      expect(h.port.scheduled.size).toBe(64);
    });

    it("stays within 64 including 5 pending cancellations", async () => {
      const h = await denseSetup();
      const pendingIds: number[] = [];
      for (let i = 0; i < 5; i++) {
        pendingIds.push(await insertNudgeRow(h, { scheduledAt: at(20, i, 15), ruleKey: `pending${i}` }));
      }
      for (const id of pendingIds) h.port.scheduled.set(id, { id, at: new Date(), title: "", body: "" });
      h.port.failCancel = (id) => pendingIds.includes(id);
      await replan(h);
      const rows = reservationRows(h.raw);
      expect(rows.filter((r) => r.state === "pending_cancel")).toHaveLength(5);
      expect(rows.filter((r) => r.kind === "nudge" && r.state === "active")).toHaveLength(58);
      expect(rows).toHaveLength(64);
      expect(h.port.scheduled.size).toBe(64);
    });
  });

  it("registers nothing (not even the report prompt) when 64 pending cancellations fill the OS limit", async () => {
    const h = await setup();
    const pendingIds: number[] = [];
    for (let i = 0; i < 64; i++) {
      pendingIds.push(await insertNudgeRow(h, { scheduledAt: at(20, i % 60, 15 + Math.floor(i / 60)), ruleKey: `p${i}` }));
    }
    for (const id of pendingIds) h.port.scheduled.set(id, { id, at: new Date(), title: "", body: "" });
    h.port.failCancel = (id) => pendingIds.includes(id);
    await replan(h);
    expect(h.port.calls.filter((c) => c.op === "register")).toHaveLength(0);
    expect(h.port.scheduled.size).toBe(64);
  });

  it("does not count future reservations in today's dashboard escalation", async () => {
    const h = await setup();
    await replan(h);
    expect(reservationRows(h.raw).some((r) => r.escalation_level === 3)).toBe(true);
    await expect(calculateTodayMaxEscalationLevel(h.db, NOW)).resolves.toBe(0);
  });

  it("counts confirmed history in today's dashboard escalation", async () => {
    const h = await setup();
    await replan(h);
    h.clock.now = new Date(2026, 8, 14, 10, 20);
    await replan(h);
    await expect(calculateTodayMaxEscalationLevel(h.db, h.clock.now)).resolves.toBe(2);
  });
});

describe("失敗の後始末が計画し直しの残りを止めない（仮定 A23）", () => {
  it("continues registering later nudges and the report prompt when a failed registration's cleanup delete also fails", async () => {
    const h = await setup();
    h.port.failRegister = (request) => request.at.getTime() === new Date(at(10, 15)).getTime();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(DELETE_RESERVATION_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    await replanner.whenIdle();
    // 10:15 の登録は失敗し、後始末の削除も失敗する（行は active のまま残る。
    // 次の計画し直しで取り消し対象になり〔OS には無い〕、削除をやり直す）。
    expect(reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))).toMatchObject({ state: "active" });
    // それでも後続の予約や固定の通知の登録は止まらない
    expect(reservationRows(h.raw).some((r) => r.scheduled_at === at(10, 25) && r.kind === "nudge")).toBe(true);
    expect(reservationRows(h.raw).some((r) => r.kind === "report_prompt")).toBe(true);
  });

  it("continues cancelling, planning and the report prompt when re-registering a canceledInOs row fails and its cleanup delete also fails", async () => {
    const h = await setup();
    await replan(h);
    const target = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    h.port.failRegister = (request) => request.id === target.id;
    const replanner = createNudgeReplanner({
      db: failingDeleteForId(h.db, target.id),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    await replanner.whenIdle();
    // target: 取り消しの削除も、登録し直しも、その削除も失敗するが、行は残り
    // 例外は外へ出ない（次の計画し直しで取り消し・削除をやり直す）。
    expect(reservationRows(h.raw).find((r) => r.id === target.id)).toMatchObject({ state: "active" });
    // 残りの計画（別の予約の取り消し・登録し直し・固定の通知）は進む
    expect(reservationRows(h.raw).some((r) => r.scheduled_at === at(10, 25) && r.kind === "nudge")).toBe(true);
    expect(reservationRows(h.raw).some((r) => r.kind === "report_prompt")).toBe(true);
  });

  it("keeps a reservation active when marking it pending_cancel also fails, and still cancels and re-plans the rest", async () => {
    const h = await setup();
    const id1 = await insertNudgeRow(h, { scheduledAt: at(12, 0, 15), ruleKey: "a" });
    const id2 = await insertNudgeRow(h, { scheduledAt: at(12, 5, 15), ruleKey: "b" });
    h.port.failCancel = (cancelId) => cancelId === id1;
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(SET_PENDING_CANCEL_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    await replanner.whenIdle();
    // id1: 取り消しにも、pending_cancel への更新にも失敗するが、例外は外へ出ない
    expect(reservationRows(h.raw).find((r) => r.id === id1)?.state).toBe("active");
    // id2: 取り消しは成功するので削除される
    expect(reservationRows(h.raw).some((r) => r.id === id2)).toBe(false);
    // 後続の処理（新しい催促の登録・固定の通知）は止まらない
    expect(reservationRows(h.raw).some((r) => r.kind === "report_prompt")).toBe(true);
    expect(reservationRows(h.raw).some((r) => r.kind === "nudge" && r.id !== id1)).toBe(true);
  });

  it("continues the remaining B/C enrichment when the delete of a reservation that failed to re-register also fails", async () => {
    const h = await setup();
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(DELETE_RESERVATION_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const target = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    // 10:15 の B の登録・元の文面への登録し直しの両方を失敗させる
    h.port.failRegister = (request) => request.id === target.id;
    await replanner.whenIdle();
    // target: 取り消しは成功する（OS からは消える）が、控えの削除は失敗するので
    // 行は DB に残る（次の計画し直しで取り消し・削除をやり直す）
    expect(h.port.scheduled.has(target.id)).toBe(false);
    expect(reservationRows(h.raw).some((r) => r.id === target.id)).toBe(true);
    // それでも他の対象（10:25）の B の生成と、C の生成は続く
    const bTimes = llmRequests()
      .filter(isIndividualRequest)
      .map((r) => /現在日時: \S+（.）(\d\d:\d\d)/.exec(String(r.system))?.[1]);
    expect(bTimes).toContain("10:25");
    expect(llmRequests().some((r) => !isIndividualRequest(r))).toBe(true);
  });
});

describe("確定した送信履歴と次の計画", () => {
  /** `evaluateRules` を 1 分ずつ呼んで発火を履歴へ積む（rule-engine.test.ts の sweep と同じ形） */
  function sweep(tasks: Task[], raw: Database.Database, from: Date, toExclusive: Date) {
    const activityEvents = raw.prepare("SELECT * FROM activity_events").all() as never[];
    const notifications: NotificationHistoryEntry[] = [];
    const fired: Array<{ ruleKey: string; level: number; at: string }> = [];
    for (let t = from; t < toExclusive; t = new Date(Math.floor(t.getTime() / 60_000) * 60_000 + 60_000)) {
      const today = t.getDate() === 14;
      for (const f of evaluateRules({
        now: t,
        tasks,
        activityEvents,
        notifications,
        settings: DEFAULT_DETECTION_SETTINGS,
        todaysSessionTypes: today ? ["morning", "evening"] : [],
      })) {
        notifications.push({ ruleKey: f.ruleKey, escalationLevel: f.escalationLevel, sentAt: t.toISOString() });
        fired.push({ ruleKey: f.ruleKey, level: f.escalationLevel, at: t.toISOString() });
      }
    }
    return fired;
  }

  it("matches the per-minute method across replans (escalation, duplicate suppression, daily cap)", async () => {
    const h = await setup();
    const tasks = (h.raw.prepare("SELECT * FROM tasks").all() as Array<Record<string, unknown>>).map(
      (row) => ({ ...row, evidence_required: row.evidence_required === 1 }) as unknown as Task,
    );
    // L1（10:00）→ L2（10:15）の途中、L3 の繰り返しの途中、日次上限に達した後で計画し直す
    const replanTimes = [NOW, new Date(2026, 8, 14, 10, 20), new Date(2026, 8, 14, 11, 7), new Date(2026, 8, 14, 13, 0)];
    for (const t of replanTimes) {
      h.clock.now = t;
      await replan(h);
    }
    const last = replanTimes[replanTimes.length - 1]!;
    const confirmed = notificationRows(h.raw).map((r) => ({
      ruleKey: r.rule_key!,
      level: r.escalation_level!,
      at: r.sent_at,
    }));
    const planned = reservationRows(h.raw)
      .filter((r) => r.kind === "nudge")
      .map((r) => ({ ruleKey: r.rule_key!, level: r.escalation_level!, at: r.scheduled_at }));

    const expected = sweep(tasks, h.raw, NOW, new Date(last.getTime() + PLAN_HORIZON_MS));
    const sortKey = (x: { ruleKey: string; level: number; at: string }) => `${x.at}|${x.ruleKey}|${x.level}`;
    expect([...confirmed, ...planned].map(sortKey).sort()).toEqual(expected.map(sortKey).sort());
    // 例の成立の確認: 日次上限（5）に達したルールと、L3 の繰り返しを含む
    expect(confirmed.filter((c) => c.ruleKey === "unstarted:1")).toHaveLength(5);
    expect(confirmed.some((c) => c.ruleKey === "silence" && c.level === 3)).toBe(true);
  });
});

describe("固定の通知", () => {
  it("is registered at the truncation time when the plan hits the limit", async () => {
    const { db, raw } = await createTestDb();
    insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 8, 50));
    insertTaskRow(raw, { created_at: new Date(2026, 8, 14, 8, 0).toISOString() });
    const h: Harness = { db, raw, port: createFakeSchedulerPort(), clock: { now: new Date(2026, 8, 14, 9, 0) }, taskId: 1 };
    await replan(h);
    const rows = reservationRows(raw);
    const nudges = rows.filter((r) => r.kind === "nudge");
    const report = rows.filter((r) => r.kind === "report_prompt");
    expect(report).toHaveLength(1);
    // 打ち切りの時刻 = 上限で返せなかった最初の発火の時刻（最後の催促以降・24 時間より前）
    expect(report[0]!.scheduled_at >= nudges[nudges.length - 1]!.scheduled_at).toBe(true);
    expect(new Date(report[0]!.scheduled_at).getTime()).toBeLessThan(h.clock.now.getTime() + PLAN_HORIZON_MS);
  });

  it("is registered at the end of the horizon (24 hours later) when the plan is not truncated", async () => {
    const h = await setup();
    await replan(h);
    const report = reservationRows(h.raw).filter((r) => r.kind === "report_prompt");
    expect(report.map((r) => r.scheduled_at)).toEqual([new Date(NOW.getTime() + PLAN_HORIZON_MS).toISOString()]);
  });

  it("is still registered once when pending cancellations reduced the nudge limit", async () => {
    const h = await setup();
    const id = await insertNudgeRow(h, { scheduledAt: at(20, 0, 15) });
    h.port.failCancel = (cancelId) => cancelId === id;
    await replan(h);
    expect(reservationRows(h.raw).filter((r) => r.kind === "report_prompt" && r.state === "active")).toHaveLength(1);
  });

  it("has the fixed body", async () => {
    const h = await setup();
    await replan(h);
    const report = reservationRows(h.raw).find((r) => r.kind === "report_prompt");
    expect(report?.body).toBe("しばらく報告が無い。アプリを開いて状況を報告しろ");
    expect(h.port.scheduled.get(report!.id)?.body).toBe("しばらく報告が無い。アプリを開いて状況を報告しろ");
  });
});

describe("計画し直しの契機", () => {
  it("confirms, cancels and registers in a single call", async () => {
    const h = await setup();
    await insertNudgeRow(h, { scheduledAt: at(9, 30) });
    const futureId = await insertNudgeRow(h, { scheduledAt: at(12, 0, 15) });
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    expect(notificationRows(h.raw)).toHaveLength(1);
    expect(h.port.calls).toContainEqual({ op: "cancel", id: futureId });
    expect(h.port.calls.filter((c) => c.op === "register").length).toBeGreaterThan(0);
    await replanner.whenIdle();
  });

  // 前の計画し直しが終わった後の要求が、終わった loop に吸われずに新しい計画し
  // 直しを始めること（基本の契約）。runLoop の末尾と後始末の間の狭い隙間
  // （PR のセルフレビューで直した競合）はこのテストでは再現しない。
  it("starts a new replan for a request made after the previous one finished", async () => {
    const h = await setup();
    const replanner = replannerFor(h);
    await replanner.requestReplan().then(() => replanner.requestReplan());
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.op === "register" && c.body === REPORT_PROMPT_BODY)).toHaveLength(2);
  });

  it("runs at most one replan at a time and exactly one more after it when called repeatedly meanwhile", async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inRegister = 0;
    let maxInRegister = 0;
    let blocked = false;
    h.port.beforeRegister = async () => {
      inRegister++;
      maxInRegister = Math.max(maxInRegister, inRegister);
      if (!blocked) {
        blocked = true;
        await gate;
      }
      inRegister--;
    };
    const replanner = replannerFor(h);
    const first = replanner.requestReplan();
    await vi.waitFor(() => expect(blocked).toBe(true));
    const second = replanner.requestReplan();
    const third = replanner.requestReplan();
    release();
    await Promise.all([first, second, third]);
    await replanner.whenIdle();
    const reportRegistrations = h.port.calls.filter((c) => c.op === "register" && c.body === REPORT_PROMPT_BODY);
    expect(reportRegistrations).toHaveLength(2);
    expect(maxInRegister).toBe(1);
  });

  it("uses the meeting time read at replan time", async () => {
    const h = await setup();
    await replan(h);
    expect(reservationRows(h.raw).some((r) => r.rule_key === "morning_meeting:2026-09-15@09:00")).toBe(true);
    putSettingRow(h.raw, "morning_meeting_time", "09:30");
    await replan(h);
    const keys = reservationRows(h.raw).map((r) => r.rule_key);
    expect(keys).not.toContain("morning_meeting:2026-09-15@09:00");
    expect(keys).toContain("morning_meeting:2026-09-15@09:30");
  });

  it("uses the working hours read at replan time", async () => {
    const h = await setup();
    await replan(h);
    const inHoursSilenceAfterNoon = () =>
      reservationRows(h.raw).filter(
        (r) => r.rule_key === "silence" && r.scheduled_at >= at(11, 0) && r.scheduled_at < at(0, 0, 15),
      );
    expect(inHoursSilenceAfterNoon().length).toBeGreaterThan(0);
    putSettingRow(h.raw, "work_end", "11:00");
    await replan(h);
    expect(inHoursSilenceAfterNoon()).toHaveLength(0);
  });

  it("uses the daily cap read at replan time", async () => {
    const h = await setup();
    // 同じ時刻に計画し直すと、予約時刻 = 今の予約（10:00 の L1）は確定される。
    // 日次上限は確定した送信履歴と予約の合計で数える。
    const todaysUnstarted = () => [
      ...reservationRows(h.raw).filter((r) => r.rule_key === "unstarted:1" && r.scheduled_at < at(0, 0, 15)),
      ...notificationRows(h.raw).filter((r) => r.rule_key === "unstarted:1"),
    ];
    await replan(h);
    expect(todaysUnstarted()).toHaveLength(5);
    putSettingRow(h.raw, "detection_daily_notification_cap", "2");
    await replan(h);
    expect(todaysUnstarted()).toHaveLength(2);
  });

  it("plans the next day's meeting with the next day's override", async () => {
    const h = await setup();
    h.raw
      .prepare(
        "INSERT INTO meeting_time_overrides (date, meeting_type, meeting_time, created_at, updated_at) VALUES (?, 'morning', '09:40', ?, ?)",
      )
      .run("2026-09-15", at(8, 0), at(8, 0));
    await replan(h);
    const keys = reservationRows(h.raw).map((r) => r.rule_key);
    expect(keys).toContain("morning_meeting:2026-09-15@09:40");
    expect(keys).not.toContain("morning_meeting:2026-09-15@09:00");
  });
});

describe("文面の順序", () => {
  it("uses a saved individual (B) body with the same content key", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    const callsAfterFirst = llmRequests().filter(isIndividualRequest).length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15));
    expect(row).toMatchObject({ body: "B:10:15", body_source: "individual" });
    // 同じ使い回しのキーの文面を持つ予約（10:15・10:25）は作り直さない。2 回目の
    // 計画し直しでは 10:00 の予約が確定済みになり、先頭 3 件に 10:35 が入る。
    const secondRoundTargets = llmRequests()
      .filter(isIndividualRequest)
      .slice(callsAfterFirst)
      .map((r) => /現在日時: \S+（.）(\d\d:\d\d)/.exec(String(r.system))?.[1]);
    expect(secondRoundTargets).toEqual(["10:35"]);
  });

  it("uses the persona's message set (C) with the task name and commitment time filled in", async () => {
    const h = await setup();
    const persona = DEFAULT_PERSONA_SETTINGS;
    const set = parseMessageSet(JSON.stringify(validMessageSetJson("C:{task}/{time}")))!;
    await saveMessageSet(h.db, await messageSetPersonaKey(persona), set, NOW);
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 35));
    expect(row?.body_source).toBe("message_set");
    expect(row?.body).toMatch(/^C:資料作成\/約束の時刻 todo_stall L3 v[012]$/);
  });

  it("fills in the commitment time for commitment_missed", async () => {
    const { db, raw } = await createTestDb();
    insertSessionRow(raw, "morning", new Date(2026, 8, 14, 9, 0));
    insertSessionRow(raw, "evening", new Date(2026, 8, 14, 9, 1));
    insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 9, 55));
    insertTaskRow(raw, {
      priority: "low",
      created_at: new Date(2026, 8, 14, 9, 0).toISOString(),
      committed_start_at: new Date(2026, 8, 14, 10, 30).toISOString(),
      committed_at: new Date(2026, 8, 14, 9, 30).toISOString(),
    });
    const h: Harness = { db, raw, port: createFakeSchedulerPort(), clock: { now: NOW }, taskId: 1 };
    const set = parseMessageSet(JSON.stringify(validMessageSetJson("C:{task}/{time}")))!;
    await saveMessageSet(db, await messageSetPersonaKey(DEFAULT_PERSONA_SETTINGS), set, NOW);
    await replan(h);
    const row = reservationRows(raw).find((r) => r.rule_key?.startsWith("commitment_missed:") && r.escalation_level === 2);
    expect(row?.body).toMatch(/^C:資料作成\/2026-09-14 10:30 commitment_missed L2/);
  });

  it("falls back to FALLBACK_TEMPLATES when neither B nor C exists", async () => {
    const h = await setup();
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 35));
    expect(row?.body_source).toBe("fallback");
    expect(row?.body).toBe("資料作成を放置しすぎだ。今すぐ着手しろ。");
  });

  it("registers reservations without waiting for the LLM", async () => {
    const h = await setup();
    let failPending!: (err: Error) => void;
    streamBossMessageMock.mockImplementation(
      () => new Promise((_resolve, reject) => (failPending = reject)),
    );
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    expect(reservationRows(h.raw).length).toBeGreaterThan(0);
    expect(h.port.scheduled.size).toBe(reservationRows(h.raw).length);
    // 後始末: 返らない生成を失敗させ、残りの上乗せを次のテストへ漏らさない
    await vi.waitFor(() => expect(failPending).toBeDefined());
    streamBossMessageMock.mockRejectedValue(new Error("done"));
    failPending(new Error("done"));
    await replanner.whenIdle();
  });
});

describe("canceledInOs の行の登録し直し（仮定 A22）", () => {
  it("re-registers with the new plan's body, body_source and content key, and a later B swap can proceed", async () => {
    const h = await setup();
    await replan(h);
    const target = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    const staleBody = "古い予約の文面";
    h.raw.prepare("UPDATE nudge_reservations SET body = ? WHERE id = ?").run(staleBody, target.id);
    insertEvidenceRow(h.raw, h.taskId); // 証跡件数が変わるので使い回しのキーも変わる
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingDeleteForId(h.db, target.id),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    await replanner.whenIdle();

    // 取り消せたが控えの削除だけ失敗した行（canceledInOs）を、古い控えの文面
    // ではなく新しい計画の文面で登録し直している
    const registerCalls = h.port.calls.filter((c) => c.op === "register" && c.id === target.id);
    expect(registerCalls.some((c) => c.body === staleBody)).toBe(false);

    const row = reservationRows(h.raw).find((r) => r.id === target.id)!;
    expect(row.body).not.toBe(staleBody);
    expect(row.content_key).not.toBe(target.content_key);
    expect(row.state).toBe("active");

    // 新しい使い回しのキーで B の生成・差し替えも進む（content_key の不一致で
    // 止まらない）
    expect(row.body).toBe("B:10:15");
    expect(row.body_source).toBe("individual");
    expect(h.port.scheduled.get(target.id)?.body).toBe("B:10:15");
  });
});

describe("B（個別生成）", () => {
  it("targets up to the first 3 reservations of the plan that have no saved body", async () => {
    const h = await setup();
    // 先頭 3 件は 10:00（予約時刻まで 0 秒・対象外）・10:15・10:25
    await replan(h);
    const systems = llmRequests().filter(isIndividualRequest).map((r) => String(r.system));
    expect(systems).toHaveLength(2);
    expect(systems.some((s) => s.includes("10:15"))).toBe(true);
    expect(systems.some((s) => s.includes("10:25"))).toBe(true);
  });

  it("does not target a reservation 59 seconds ahead, and targets one 60 seconds ahead", async () => {
    // 無音の L1 は 10:40（09:55 の報告から 45 分）に固定で来る
    const targetsSilenceAt1040 = () =>
      llmRequests()
        .filter(isIndividualRequest)
        .some((r) => String(r.system).includes("10:40") && String(r.messages[0]?.content).includes("無音"));
    const h59 = await setup();
    h59.clock.now = new Date(2026, 8, 14, 10, 39, 1);
    await replan(h59);
    expect(targetsSilenceAt1040()).toBe(false);

    streamBossMessageMock.mockClear();
    const h60 = await setup();
    h60.clock.now = new Date(2026, 8, 14, 10, 39, 0);
    await replan(h60);
    expect(targetsSilenceAt1040()).toBe(true);
  });

  it("builds the request exactly like the send-time generation, with the scheduled time as the current time", async () => {
    const h = await setup();
    await replan(h);
    const bRequest = llmRequests().find((r) => isIndividualRequest(r) && String(r.system).includes("10:15"))!;
    streamBossMessageMock.mockClear();
    const task = { ...(h.raw.prepare("SELECT * FROM tasks WHERE id = 1").get() as Task), evidence_required: false };
    await generateNotificationBody(h.db, {}, {
      ruleType: "todo_stall",
      escalationLevel: 2,
      task,
      now: new Date(2026, 8, 14, 10, 15),
    });
    expect(bRequest).toEqual(llmRequests()[0]);
  });

  it("does not send the task description", async () => {
    const { db, raw } = await createTestDb();
    insertSessionRow(raw, "morning", new Date(2026, 8, 14, 9, 0));
    insertSessionRow(raw, "evening", new Date(2026, 8, 14, 9, 1));
    insertActivityRow(raw, "checkin", new Date(2026, 8, 14, 9, 55));
    insertTaskRow(raw, { description: "社外秘の説明文", created_at: new Date(2026, 8, 14, 9, 0).toISOString() });
    await replan({ db, raw, port: createFakeSchedulerPort(), clock: { now: NOW }, taskId: 1 });
    const bRequests = llmRequests().filter(isIndividualRequest);
    expect(bRequests.length).toBeGreaterThan(0);
    for (const r of bRequests) expect(requestText(r)).not.toContain("社外秘の説明文");
  });

  it("does not send tasks other than the target", async () => {
    const h = await setup();
    insertTaskRow(h.raw, { title: "別件の機密タスク", status: "done", created_at: at(8, 0) });
    await replan(h);
    const bRequests = llmRequests().filter(isIndividualRequest);
    expect(bRequests.length).toBeGreaterThan(0);
    for (const r of bRequests) expect(requestText(r)).not.toContain("別件の機密タスク");
  });

  it("sends the target task's evidence count", async () => {
    const h = await setup();
    insertEvidenceRow(h.raw, h.taskId);
    insertEvidenceRow(h.raw, h.taskId);
    await replan(h);
    const bRequest = llmRequests().find((r) => isIndividualRequest(r) && String(r.system).includes("10:15"))!;
    expect(String(bRequest.system)).toContain("添付2件");
  });

  it("does not reuse the B body after an evidence is attached (the content key changes)", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    const before = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    expect(before.body_source).toBe("individual");
    insertEvidenceRow(h.raw, h.taskId);
    streamBossMessageMock.mockImplementation(async () => textMessage("B:after"));
    await replan(h);
    const after = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    expect(after.content_key).not.toBe(before.content_key);
    expect(after.body).toBe("B:after");
  });

  it("swaps the reservation to the B body (OS and reservation row)", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    expect(row).toMatchObject({ body: "B:10:15", body_source: "individual" });
    expect(h.port.scheduled.get(row.id)?.body).toBe("B:10:15");
  });

  async function swapAtLead(leadMs: number): Promise<Harness> {
    const h = await setup();
    const target = new Date(2026, 8, 14, 10, 15).getTime();
    streamBossMessageMock.mockImplementation(async (_c: unknown, request: ClaudeMessageRequest) => {
      if (isIndividualRequest(request) && String(request.system).includes("10:15")) {
        h.clock.now = new Date(target - leadMs);
        return textMessage("B:10:15");
      }
      throw new Error("other");
    });
    await replan(h);
    return h;
  }

  it("does not swap when fewer than 30 seconds remain (29 s), and swaps at 30 s", async () => {
    const h29 = await swapAtLead(29_000);
    expect(reservationRows(h29.raw).find((r) => r.scheduled_at === at(10, 15))?.body_source).toBe("fallback");
    const h30 = await swapAtLead(30_000);
    expect(reservationRows(h30.raw).find((r) => r.scheduled_at === at(10, 15))?.body_source).toBe("individual");
  });

  it("does not swap when the reservation is gone by the time the generation finishes", async () => {
    const h = await setup();
    streamBossMessageMock.mockImplementation(async (_c: unknown, request: ClaudeMessageRequest) => {
      if (isIndividualRequest(request) && String(request.system).includes("10:15")) {
        h.raw.prepare("DELETE FROM nudge_reservations WHERE scheduled_at = ?").run(at(10, 15));
        return textMessage("B:10:15");
      }
      throw new Error("other");
    });
    await replan(h);
    expect(h.port.calls.some((c) => c.op === "register" && c.body === "B:10:15")).toBe(false);
  });

  it.each([
    ["its content key changed (a replan re-planned it with different content)", "UPDATE nudge_reservations SET content_key = 'changed' WHERE scheduled_at = ?"],
    ["it became pending_cancel", "UPDATE nudge_reservations SET state = 'pending_cancel' WHERE scheduled_at = ?"],
  ])("does not swap when, by the time the generation finishes, %s", async (_label, sql) => {
    const h = await setup();
    streamBossMessageMock.mockImplementation(async (_c: unknown, request: ClaudeMessageRequest) => {
      if (isIndividualRequest(request) && String(request.system).includes("10:15")) {
        h.raw.prepare(sql).run(at(10, 15));
        return textMessage("B:10:15");
      }
      throw new Error("other");
    });
    await replan(h);
    expect(h.port.calls.some((c) => c.op === "register" && c.body === "B:10:15")).toBe(false);
    expect(reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))?.body_source).toBe("fallback");
  });

  it("with a replacing port, swaps with a single register and no cancel", async () => {
    const h = await setup({ replacesSameId: true });
    llmSucceeds();
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    const id = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!.id;
    h.port.calls = [];
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === id)).toEqual([{ op: "register", id, body: "B:10:15" }]);
  });

  it("with a non-replacing port, cancels and then registers the B body", async () => {
    const h = await setup({ replacesSameId: false });
    llmSucceeds();
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    const id = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!.id;
    h.port.calls = [];
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === id)).toEqual([
      { op: "cancel", id },
      { op: "register", id, body: "B:10:15" },
    ]);
  });

  it("re-registers the previous body when registering the B body fails, keeping the row's body", async () => {
    const h = await setup();
    llmSucceeds();
    h.port.failRegister = (request) => request.body.startsWith("B:");
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    expect(row.body_source).toBe("fallback");
    expect(h.port.scheduled.get(row.id)).toMatchObject({ body: row.body, at: new Date(at(10, 15)) });
  });

  it("removes the reservation row when re-registering the previous body also fails", async () => {
    const h = await setup();
    llmSucceeds();
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    const id = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!.id;
    h.port.failRegister = (request) => request.at.getTime() === new Date(at(10, 15)).getTime();
    await replanner.whenIdle();
    expect(reservationRows(h.raw).some((r) => r.scheduled_at === at(10, 15))).toBe(false);
    // 控えを消す前に取り消しを試み、取り消せない予約を OS に残さない（仮定 A16）
    expect(h.port.calls).toContainEqual({ op: "cancel", id });
    expect(h.port.scheduled.has(id)).toBe(false);
  });

  it("with a non-replacing port, does not swap when the cancellation fails", async () => {
    const h = await setup({ replacesSameId: false });
    llmSucceeds();
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    const id = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!.id;
    h.port.failCancel = (cancelId) => cancelId === id;
    h.port.calls = [];
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === id && c.op === "register")).toHaveLength(0);
    expect(reservationRows(h.raw).find((r) => r.id === id)?.body_source).toBe("fallback");
  });

  it("with a replacing port, re-registers the row's body when only recording the B body fails", async () => {
    const h = await setup({ replacesSameId: true });
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(UPDATE_BODY_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    h.port.calls = [];
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === row.id)).toEqual([
      { op: "register", id: row.id, body: "B:10:15" },
      { op: "register", id: row.id, body: row.body },
    ]);
    expect(reservationRows(h.raw).find((r) => r.id === row.id)).toMatchObject({ body: row.body, body_source: "fallback" });
    expect(h.port.scheduled.get(row.id)?.body).toBe(row.body);
  });

  it("with a non-replacing port, removes the row when recording fails and re-registering the previous body after cancelling B also fails", async () => {
    const h = await setup({ replacesSameId: false });
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(UPDATE_BODY_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    h.port.calls = [];
    h.port.failRegister = (request) => request.id === row.id && request.body === row.body;
    await replanner.whenIdle();
    // B は取り消し済みで OS に何も無いため、「登録に失敗した予約」として控えから消す（仮定 A16）
    expect(h.port.scheduled.has(row.id)).toBe(false);
    expect(reservationRows(h.raw).some((r) => r.id === row.id)).toBe(false);
  });

  it("with a replacing port, keeps the B notification and the row when recording and restoring the previous body both fail", async () => {
    const h = await setup({ replacesSameId: true });
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(UPDATE_BODY_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    h.port.calls = [];
    // B の登録（body="B:10:15"）は成功させ、元の文面（row.body）での登録し
    // 直しだけを失敗させる
    h.port.failRegister = (request) => request.id === row.id && request.body === row.body;
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === row.id)).toEqual([
      { op: "register", id: row.id, body: "B:10:15" },
      { op: "register", id: row.id, body: row.body },
    ]);
    // 置き換えるポートで B の登録が成功しているので、取り消しも控えの削除も
    // しない（催促を失わない。仮定 A21）
    expect(h.port.calls.some((c) => c.id === row.id && c.op === "cancel")).toBe(false);
    expect(h.port.scheduled.get(row.id)?.body).toBe("B:10:15");
    expect(reservationRows(h.raw).find((r) => r.id === row.id)).toMatchObject({ body: row.body, body_source: "fallback" });
  });

  it("with a non-replacing port, cancels the B notification before re-registering the row's body when only recording fails", async () => {
    const h = await setup({ replacesSameId: false });
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(UPDATE_BODY_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    h.port.calls = [];
    await replanner.whenIdle();
    expect(h.port.calls.filter((c) => c.id === row.id)).toEqual([
      { op: "cancel", id: row.id },
      { op: "register", id: row.id, body: "B:10:15" },
      { op: "cancel", id: row.id },
      { op: "register", id: row.id, body: row.body },
    ]);
    expect(reservationRows(h.raw).find((r) => r.id === row.id)).toMatchObject({ body: row.body, body_source: "fallback" });
    expect(h.port.scheduled.get(row.id)?.body).toBe(row.body);
  });

  it("with a non-replacing port, keeps the B notification and the row when recording and cancelling the B body both fail", async () => {
    const h = await setup({ replacesSameId: false });
    llmSucceeds();
    const replanner = createNudgeReplanner({
      db: failingWrites(h.db, (sql) => sql.startsWith(UPDATE_BODY_SQL)),
      env: {},
      port: h.port,
      clock: () => h.clock.now,
    });
    await replanner.requestReplan();
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))!;
    let cancels = 0;
    h.port.failCancel = (id) => id === row.id && ++cancels > 1;
    await replanner.whenIdle();
    expect(h.port.scheduled.get(row.id)?.body).toBe("B:10:15");
    expect(reservationRows(h.raw).some((r) => r.id === row.id)).toBe(true);
  });

  it.each([
    ["an exception", () => streamBossMessageMock.mockRejectedValue(new Error("x"))],
    ["an empty response", () => streamBossMessageMock.mockResolvedValue(textMessage(""))],
    ["a response empty after normalization", () => streamBossMessageMock.mockResolvedValue(textMessage("<p></p>"))],
  ])("keeps the previous body when the generation fails with %s", async (_label, arrange) => {
    const h = await setup();
    arrange();
    await replan(h);
    expect(reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 15))?.body_source).toBe("fallback");
  });

  it("stops generating once 12 attempts were made in the last hour, even with a fresh replanner", async () => {
    const h = await setup();
    const stmt = h.raw.prepare("INSERT INTO nudge_generation_attempts (kind, attempted_at) VALUES ('individual', ?)");
    for (let i = 0; i < 12; i++) stmt.run(at(9, 30));
    await replan(h);
    expect(llmRequests().filter(isIndividualRequest)).toHaveLength(0);
  });

  it("does not use an attempt when no LLM client can be created", async () => {
    const h = await setup();
    createClaudeClientMock.mockImplementation(() => {
      throw new Error("not registered");
    });
    await replan(h);
    expect(h.raw.prepare("SELECT COUNT(*) AS c FROM nudge_generation_attempts").get()).toEqual({ c: 0 });
  });

  it("counts failed generations as attempts", async () => {
    const h = await setup();
    await replan(h);
    const count = (h.raw.prepare("SELECT COUNT(*) AS c FROM nudge_generation_attempts WHERE kind = 'individual'").get() as { c: number }).c;
    expect(count).toBe(2);
  });

});

describe("B の使い回しのキー", () => {
  const baseTask: Task = {
    id: 1,
    title: "資料作成",
    description: null,
    category: "work",
    priority: "high",
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    created_at: at(9, 0),
    updated_at: at(9, 0),
    completed_at: null,
    evidence_required: false,
    committed_start_at: at(10, 30),
    committed_at: at(9, 30),
  };
  const baseSettings = { model: "claude-sonnet-5", persona: DEFAULT_PERSONA_SETTINGS };
  const base: NotificationBodyRequest = {
    ruleType: "commitment_missed",
    escalationLevel: 1,
    task: baseTask,
    now: new Date(2026, 8, 14, 10, 45),
  };
  const keyOf = (settings: typeof baseSettings, request: NotificationBodyRequest) =>
    individualContentKey(buildNotificationLlmRequest(settings, request));

  it.each([
    ["the persona name", { ...baseSettings, persona: { ...DEFAULT_PERSONA_SETTINGS, name: "別名" } }, base],
    ["the persona tone", { ...baseSettings, persona: { ...DEFAULT_PERSONA_SETTINGS, tone: "strict" as const } }, base],
    ["the persona strictness", { ...baseSettings, persona: { ...DEFAULT_PERSONA_SETTINGS, strictness: 5 } }, base],
    ["the custom instructions", { ...baseSettings, persona: { ...DEFAULT_PERSONA_SETTINGS, customInstructions: "短く" } }, base],
    ["the rule type", baseSettings, { ...base, ruleType: "todo_stall" as const }],
    ["the escalation level", baseSettings, { ...base, escalationLevel: 2 as const }],
    ["the task status", baseSettings, { ...base, task: { ...baseTask, status: "paused" as const } }],
    ["the task priority", baseSettings, { ...base, task: { ...baseTask, priority: "low" as const } }],
    ["whether evidence is required", baseSettings, { ...base, task: { ...baseTask, evidence_required: true } }],
    ["the evidence count", baseSettings, { ...base, taskEvidenceCount: 1 }],
    ["the deadline", baseSettings, { ...base, task: { ...baseTask, due_at: "2026-09-20" } }],
    ["the commitment time", baseSettings, { ...base, task: { ...baseTask, committed_start_at: at(11, 0) } }],
    ["the scheduled time", baseSettings, { ...base, now: new Date(2026, 8, 14, 10, 55) }],
  ])("changes when %s changes", async (_label, settings, request) => {
    await expect(keyOf(settings, request)).resolves.not.toBe(await keyOf(baseSettings, base));
  });

  it("does not change when nothing changes", async () => {
    await expect(keyOf(baseSettings, { ...base })).resolves.toBe(await keyOf(baseSettings, base));
  });
});

describe("C（文面セット）", () => {
  function messageSetRequests(): ClaudeMessageRequest[] {
    return llmRequests().filter((r) => !isIndividualRequest(r));
  }

  it("generates and saves the message set after a replan when none exists", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    const rows = h.raw.prepare("SELECT persona_key FROM nudge_message_sets").all() as Array<{ persona_key: string }>;
    expect(rows).toEqual([{ persona_key: await messageSetPersonaKey(DEFAULT_PERSONA_SETTINGS) }]);
  });

  it.each([
    ["boss_name", "スミス"],
    ["boss_tone_preset", "strict"],
    ["boss_strictness", "5"],
    ["boss_custom_instructions", "語尾は「である」"],
  ])("regenerates when the persona setting %s changes", async (key, value) => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    expect(messageSetRequests()).toHaveLength(1);
    putSettingRow(h.raw, key, value);
    await replan(h);
    expect(messageSetRequests()).toHaveLength(2);
  });

  it("does not regenerate when the persona is unchanged", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    await replan(h);
    expect(messageSetRequests()).toHaveLength(1);
  });

  it("does not send task information", async () => {
    const { db, raw } = await createTestDb();
    insertTaskRow(raw, {
      title: "極秘プロジェクト",
      description: "社外秘の説明文",
      due_at: "2026-09-30",
      committed_start_at: new Date(2026, 8, 14, 16, 45).toISOString(),
      committed_at: new Date(2026, 8, 14, 9, 30).toISOString(),
      created_at: at(9, 0),
    });
    llmSucceeds();
    await replan({ db, raw, port: createFakeSchedulerPort(), clock: { now: NOW }, taskId: 1 });
    const [request] = messageSetRequests();
    expect(request).toBeDefined();
    for (const secret of ["極秘プロジェクト", "社外秘の説明文", "2026-09-30", "16:45", "未着手）", "優先度"]) {
      expect(requestText(request!)).not.toContain(secret);
    }
  });

  it("does not send the current date/time or a time-of-day hint", async () => {
    const h = await setup();
    llmSucceeds();
    await replan(h);
    const text = requestText(messageSetRequests()[0]!);
    for (const marker of ["現在日時", "2026-09-14", "10:00", "朝:", "日中:", "夕方:", "夜:"]) {
      expect(text).not.toContain(marker);
    }
  });

  it("does not save a response with the wrong shape", async () => {
    const h = await setup();
    streamBossMessageMock.mockImplementation(async (_c: unknown, request: ClaudeMessageRequest) =>
      isIndividualRequest(request) ? textMessage("B") : textMessage('{"todo_stall": {}}'),
    );
    await replan(h);
    expect(h.raw.prepare("SELECT COUNT(*) AS c FROM nudge_message_sets").get()).toEqual({ c: 0 });
  });

  it("keeps the new persona's set when a generation for the old persona finishes after the persona changed", async () => {
    const h = await setup();
    const NEW_INSTRUCTIONS = "語尾は「である」";
    let finishOld: (() => void) | undefined;
    streamBossMessageMock.mockImplementation(async (_c: unknown, request: ClaudeMessageRequest) => {
      if (isIndividualRequest(request)) return textMessage("B");
      if (requestText(request).includes(NEW_INSTRUCTIONS)) {
        return textMessage(JSON.stringify(validMessageSetJson("新:{task}/{time}")));
      }
      await new Promise<void>((resolve) => (finishOld = resolve));
      return textMessage(JSON.stringify(validMessageSetJson("旧:{task}/{time}")));
    });
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    await vi.waitFor(() => expect(finishOld).toBeDefined());

    putSettingRow(h.raw, "boss_custom_instructions", NEW_INSTRUCTIONS);
    const newKey = await messageSetPersonaKey({ ...DEFAULT_PERSONA_SETTINGS, customInstructions: NEW_INSTRUCTIONS });
    await replanner.requestReplan();
    await vi.waitFor(() =>
      expect(h.raw.prepare("SELECT persona_key FROM nudge_message_sets").all()).toEqual([{ persona_key: newKey }]),
    );

    finishOld!();
    await replanner.whenIdle();
    expect(h.raw.prepare("SELECT persona_key FROM nudge_message_sets").all()).toEqual([{ persona_key: newKey }]);
  });

  it("stops generating after 3 attempts in the local day", async () => {
    const h = await setup();
    const stmt = h.raw.prepare("INSERT INTO nudge_generation_attempts (kind, attempted_at) VALUES ('message_set', ?)");
    for (let i = 0; i < 3; i++) stmt.run(at(8, i));
    llmSucceeds();
    await replan(h);
    expect(messageSetRequests()).toHaveLength(0);
  });
});

describe("並走する上乗せ", () => {
  /**
   * 1 回目の上乗せが保存済みの文面を読んでいる途中（`table` を読む最初の
   * `get` が結果を返す前）で止め、その間に 2 回目の計画し直しを走らせるための DB。止めるのは
   * 固定の通知の登録（計画し直しの最後の書き込み）より後に来た 1 回だけ。
   */
  function gatedDb(h: Harness, table: string) {
    let armed = false;
    let release: (() => void) | undefined;
    const db: DbPort = {
      run: (sql, params) => h.db.run(sql, params),
      all: (sql, params) => h.db.all(sql, params),
      exec: (sql) => h.db.exec(sql),
      transaction: (fn) => h.db.transaction(fn),
      async get<T>(sql: string, params?: Parameters<DbPort["get"]>[1]): Promise<T | undefined> {
        const row = await h.db.get<T>(sql, params);
        if (armed && sql.includes(`FROM ${table}`)) {
          // 読んだ結果（まだ無い）を返すのを止める＝参照が終わっていない状態
          armed = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return row;
      },
    };
    let armedOnce = false;
    h.port.beforeRegister = async (request) => {
      if (!armedOnce && request.body === REPORT_PROMPT_BODY) {
        armedOnce = true;
        armed = true;
      }
    };
    return { db, released: () => release !== undefined, release: () => release!() };
  }

  function attemptCount(h: Harness, kind: "individual" | "message_set"): number {
    return (
      h.raw.prepare("SELECT COUNT(*) AS c FROM nudge_generation_attempts WHERE kind = ?").get(kind) as { c: number }
    ).c;
  }

  /** B を生成した予約の時刻（重複があればそのまま並ぶ） */
  function individualTargetTimes(): string[] {
    return llmRequests()
      .filter(isIndividualRequest)
      .map((r) => /現在日時: \S+（.）(\d\d:\d\d)/.exec(String(r.system))?.[1] ?? "?");
  }

  /** マイクロタスクと crypto.subtle の完了を流しきる */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("generates B once and uses one attempt per reservation when a replan starts while the cache lookup is pending", async () => {
    const h = await setup();
    llmSucceeds();
    const gate = gatedDb(h, "nudge_individual_bodies");
    const replanner = createNudgeReplanner({ db: gate.db, env: {}, port: h.port, clock: () => h.clock.now });
    await replanner.requestReplan();
    await vi.waitFor(() => expect(gate.released()).toBe(true));

    await replanner.requestReplan();
    await settle();
    gate.release();
    await replanner.whenIdle();

    // 2 回目は 10:00 が送信履歴へ確定し、対象は 10:15・10:25・10:35 になる
    expect(individualTargetTimes().sort()).toEqual(["10:15", "10:25", "10:35"]);
    expect(attemptCount(h, "individual")).toBe(3);
  });

  it("generates C once and uses one attempt when a replan starts while the cache lookup is pending", async () => {
    const h = await setup();
    llmSucceeds();
    const gate = gatedDb(h, "nudge_message_sets");
    const replanner = createNudgeReplanner({ db: gate.db, env: {}, port: h.port, clock: () => h.clock.now });
    await replanner.requestReplan();
    await vi.waitFor(() => expect(gate.released()).toBe(true));

    await replanner.requestReplan();
    await settle();
    gate.release();
    await replanner.whenIdle();

    expect(llmRequests().filter((r) => !isIndividualRequest(r))).toHaveLength(1);
    expect(attemptCount(h, "message_set")).toBe(1);
  });

  it("releases the claim when it stops before generating, so a later replan generates B and C", async () => {
    const h = await setup();
    llmSucceeds();
    createClaudeClientMock.mockImplementation(() => {
      throw new Error("not registered");
    });
    const replanner = replannerFor(h);
    await replanner.requestReplan();
    await replanner.whenIdle();
    expect(llmRequests()).toHaveLength(0);

    createClaudeClientMock.mockReturnValue({});
    await replanner.requestReplan();
    await replanner.whenIdle();
    expect(individualTargetTimes().sort()).toEqual(["10:15", "10:25", "10:35"]);
    expect(llmRequests().filter((r) => !isIndividualRequest(r))).toHaveLength(1);
  });
});

describe("固定文へのフォールバックの内容", () => {
  it("uses buildFallbackBody for the rule and level", async () => {
    const h = await setup();
    await replan(h);
    const row = reservationRows(h.raw).find((r) => r.scheduled_at === at(10, 40))!;
    expect(row.body).toBe(buildFallbackBody({ ruleType: "silence", escalationLevel: 1, task: null, now: NOW }));
  });
});

describe("選択の解決関数（#581 S3・機能仕様 docs/features/secure-transport-byok.md クリティカル設計決定 7）", () => {
  afterEach(() => {
    resetLlmSelectionResolverForTest();
  });

  it("S3-S19: 催促の予約の文面の生成は、解決関数が返した名前のバックエンドでクライアントを作る", async () => {
    // `env` は空（`LLM_BACKEND` 未設定なら claude-code）だが、解決関数は byok-openai を返す。
    setLlmSelectionResolver(() => ({ backend: "byok-openai", model: "model-from-the-resolver" }));
    llmSucceeds();
    const h = await setup();
    await replan(h);
    expect(createClaudeClientMock).toHaveBeenCalled();
    expect(createClaudeClientMock.mock.calls.map((call) => call[1])).toEqual(
      createClaudeClientMock.mock.calls.map(() => "byok-openai"),
    );
  });

  it("S3-S20: 催促の予約の文面の要求の model は、解決関数が返したモデルである", async () => {
    setLlmSelectionResolver(() => ({ backend: "byok-openai", model: "model-from-the-resolver" }));
    llmSucceeds();
    const h = await setup();
    await replan(h);
    const models = llmRequests().map((request) => request.model);
    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(models.map(() => "model-from-the-resolver"));
  });

  it("解決関数が例外を投げても計画し直しは続き、文面の生成だけをやめる（LLM_BACKEND が許容外の開発者用の版）", async () => {
    setLlmSelectionResolver(() => {
      throw new Error("invalid LLM_BACKEND");
    });
    llmSucceeds();
    const h = await setup();
    await replan(h);
    expect(h.port.scheduled.size).toBeGreaterThan(0);
    expect(createClaudeClientMock).not.toHaveBeenCalled();
  });
});
