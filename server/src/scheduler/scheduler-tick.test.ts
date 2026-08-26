import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { insertSession } from "../sessions/sessions-repository.js";
import type { SessionType } from "../sessions/session.js";
import { listNotificationsSince } from "../notifications/notifications-repository.js";
import { DETECTION_RULE_TYPES, type DetectionRuleType } from "../detection/detection-types.js";

const {
  createClaudeClientMock,
  streamBossMessageMock,
  generateNotificationBodyMock,
  insertNotificationMock,
} = vi.hoisted(() => ({
  createClaudeClientMock: vi.fn(),
  streamBossMessageMock: vi.fn(),
  generateNotificationBodyMock: vi.fn(),
  insertNotificationMock: vi.fn(),
}));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
  };
});

// 個別テストで「1 件目の firing だけ失敗」を決定的に再現するためモック化する。
// 既定（beforeEach）では実実装へ委譲するので他のテストの挙動は変わらない。
vi.mock("../notifications/notification-body.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../notifications/notification-body.js")>();
  return {
    ...actual,
    generateNotificationBody: generateNotificationBodyMock,
  };
});

// per-firing 分離のテスト（文面生成より*後ろ*の段階の失敗が、当該 firing だけを
// 失敗させ、他の firing を止めないこと）で「1 件目の firing だけ DB 記録に失敗」
// を決定的に再現するためモック化する。既定（beforeEach）では実実装へ委譲する。
vi.mock("../notifications/notifications-repository.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../notifications/notifications-repository.js")>();
  return {
    ...actual,
    insertNotification: insertNotificationMock,
  };
});

const { createTicker } = await import("./scheduler-tick.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");
const { generateNotificationBody: actualGenerateNotificationBody } =
  await vi.importActual<typeof import("../notifications/notification-body.js")>(
    "../notifications/notification-body.js",
  );
const { insertNotification: actualInsertNotification } =
  await vi.importActual<typeof import("../notifications/notifications-repository.js")>(
    "../notifications/notifications-repository.js",
  );

function ok(): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve({ stdout: "", stderr: "" });
}

/**
 * These tick-orchestration tests focus on the wiring (fire -> generate body
 * -> send -> record), not on notification-body's own Claude-call behavior
 * (already covered by notification-body.test.ts). No `ANTHROPIC_API_KEY` is
 * ever injected, so `createClaudeClient` always throws `MissingApiKeyError`
 * and every case deterministically exercises the documented fallback-
 * template path — with one exception: the Issue #205 test below mocks
 * `generateNotificationBody` itself to throw, which bypasses
 * `createClaudeClient` entirely and instead exercises `processFiring`'s own
 * (scheduler-side) fallback path in `scheduler-tick.ts`.
 *
 * The system clock (`Date`, not timers) is faked so that `tick()`'s default
 * `now` and the repositories' server-managed timestamps (`tasks.created_at`,
 * `notifications.sent_at`, `activity_events.created_at` — all stamped via
 * `new Date().toISOString()`) stay consistent with each other as the test
 * advances time, instead of drifting against a real wall clock.
 */
function markTodaysMeetingsDone(db: Database.Database): void {
  for (const type of ["morning", "evening"] as SessionType[]) {
    insertSession(db, { type });
  }
}

/** `baseTime` から `minutes` 分だけ進めた `Date` を返す（TZ 非依存: 相対計算のみ） */
function addMinutes(baseTime: Date, minutes: number): Date {
  return new Date(baseTime.getTime() + minutes * 60 * 1000);
}

/**
 * 休憩ゲート（`!activeBreak`）のテストで使う「申告時間が絶対に超過しない」
 * 休憩の `expected_minutes`。休憩ゲートは `break_overrun` 自身の超過判定とは
 * 独立の仕組み（`if (!activeBreak) {...}` の外側で `break_overrun` を評価する
 * ため）だが、この値が小さすぎると `break_overrun` も一緒に発火してしまい、
 * 「休憩ゲートで抑制された」という 0 件アサーションが無関係な理由で崩れる。
 * `RULE_GATE_SCENARIOS` 中で最大の経過時間（silence の 46 分）より十分大きい。
 */
const NEVER_OVERRUNNING_BREAK_MINUTES = 999;

/**
 * 個別ルールを tick 経由で発火させるための最小セットアップ。`setup` は
 * `baseTime` を起点にモック時刻を操作しながら DB へ状態を仕込み、最後に
 * 「そのルールの条件が成立する tick 時刻」までモック時刻を進めて、期待される
 * `rule_key` を返す（呼び出し側はこの直後に `ticker.tick()` を呼ぶだけでよい）。
 *
 * `baseTime` を勤務時間帯内（例: 09:00）と勤務時間帯外（例: 20:00）で
 * 差し替えるだけで、同一シナリオを両方の条件で流せる（GAP-02, #196/#239 の
 * テーブル駆動・positive control に使う）。
 */
interface RuleGateScenario {
  ruleType: DetectionRuleType;
  setup: (db: Database.Database, baseTime: Date) => string;
}

const RULE_GATE_SCENARIOS: RuleGateScenario[] = [
  {
    ruleType: "unstarted",
    setup: (db, baseTime) => {
      vi.setSystemTime(baseTime);
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: "high",
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: 30,
      });
      markTodaysMeetingsDone(db);
      // Past the (scaled) unstarted threshold for a 30-minute task (30 min).
      vi.setSystemTime(addMinutes(baseTime, 31));
      return `unstarted:${task.id}`;
    },
  },
  {
    ruleType: "avoidance",
    setup: (db, baseTime) => {
      vi.setSystemTime(baseTime);
      const topTask = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: "high",
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: 15,
      });
      const otherTask = insertTask(db, {
        title: "別件",
        description: null,
        category: "work",
        priority: "low",
        due_at: null,
        status: "todo",
        boss_comment: null,
        estimated_minutes: null,
      });
      markTodaysMeetingsDone(db);
      // Recent activity on the *other* (non-top-priority) task, inside the
      // avoidance window (30 min default).
      vi.setSystemTime(addMinutes(baseTime, 16));
      recordActivityEvent(db, { type: "task_update", task_id: otherTask.id });
      // Past the top task's (scaled) unstarted threshold (15 min) and still
      // inside the avoidance window relative to the task_update above.
      vi.setSystemTime(addMinutes(baseTime, 20));
      return `avoidance:${topTask.id}`;
    },
  },
  {
    ruleType: "break_overrun",
    setup: (db, baseTime) => {
      vi.setSystemTime(baseTime);
      recordActivityEvent(db, { type: "break_start", expected_minutes: 15 });
      markTodaysMeetingsDone(db);
      // Past the declared 15-minute break.
      vi.setSystemTime(addMinutes(baseTime, 31));
      return "break_overrun";
    },
  },
  {
    ruleType: "silence",
    setup: (db, baseTime) => {
      vi.setSystemTime(baseTime);
      recordActivityEvent(db, { type: "checkin" });
      markTodaysMeetingsDone(db);
      // Past the silence fallback threshold (45 min default; no in-progress
      // task with estimated_minutes exists, so the fallback applies).
      vi.setSystemTime(addMinutes(baseTime, 46));
      return "silence";
    },
  },
  {
    ruleType: "deadline_overdue",
    setup: (db, baseTime) => {
      vi.setSystemTime(baseTime);
      // Absolute due_at computed relative to baseTime (TZ 非依存).
      const dueAt = new Date(baseTime.getTime() - 60 * 60 * 1000).toISOString();
      const task = insertTask(db, {
        title: "資料作成",
        description: null,
        category: "work",
        priority: "high",
        due_at: dueAt,
        status: "in_progress",
        boss_comment: null,
        estimated_minutes: null,
      });
      markTodaysMeetingsDone(db);
      // due_at is already 1h before baseTime, so any tick at/after baseTime
      // clears findOverdueTasks's `due_at < now` check; unlike the other
      // scenarios, this offset is not tied to a threshold — it just keeps
      // the tick time consistent with the other scenarios' (0, 46] range.
      vi.setSystemTime(addMinutes(baseTime, 31));
      return `deadline_overdue:${task.id}`;
    },
  },
];

it("RULE_GATE_SCENARIOS declares exactly one scenario per rule type the working-hours/break gates can suppress", () => {
  // Guards against a rule type silently gaining no tick-level gate coverage
  // (e.g. a new DetectionRuleType added inside evaluateRules's gates without
  // a matching entry here).
  const coveredRuleTypes = RULE_GATE_SCENARIOS.map((s) => s.ruleType).sort();
  const gatedRuleTypes = DETECTION_RULE_TYPES.filter(
    (type) => type !== "morning_meeting" && type !== "evening_meeting",
  ).sort();
  expect(coveredRuleTypes).toEqual(gatedRuleTypes);
});

describe("createTicker().tick", () => {
  let db: Database.Database;
  const env = {};

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    generateNotificationBodyMock.mockReset();
    insertNotificationMock.mockReset();
    createClaudeClientMock.mockImplementation(() => {
      throw new MissingApiKeyError();
    });
    generateNotificationBodyMock.mockImplementation(actualGenerateNotificationBody);
    insertNotificationMock.mockImplementation(actualInsertNotification);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-05T09:00:00.000"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires, generates a body, sends the notification, and records it when a rule condition is met", async () => {
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);

    // Past the (scaled) unstarted threshold for a 30-minute task.
    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));

    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    await ticker.tick();

    expect(execFile).toHaveBeenCalledWith(
      "terminal-notifier",
      expect.arrayContaining(["-title", "-message"]),
    );

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      type: "unstarted",
      rule_key: `unstarted:${task.id}`,
      escalation_level: 1,
    });
    expect(recorded[0].body).toContain("資料作成");
    db.close();
  });

  it("does not resend within the escalation interval on the next tick (duplicate suppression)", async () => {
    insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);

    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));
    await ticker.tick();

    // One minute later: well within the L1->L2 escalation interval (15 min
    // default), so no additional notification should be sent.
    vi.setSystemTime(new Date("2026-07-05T09:32:00.000"));
    await ticker.tick();

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    db.close();
  });

  it("resets the escalation level to L1 after an activity signal is recorded", async () => {
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);

    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));
    await ticker.tick();

    vi.setSystemTime(new Date("2026-07-05T09:32:00.000"));
    recordActivityEvent(db, { type: "task_update", task_id: task.id });

    vi.setSystemTime(new Date("2026-07-05T09:33:00.000"));
    await ticker.tick();

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toMatchObject({ escalation_level: 1 });
    db.close();
  });

  it("does not crash and still records the notification when sending fails (both channels reject)", async () => {
    insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);
    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));

    const execFile = vi.fn().mockRejectedValue(new Error("boom"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ticker = createTicker({ db, env, execFile });

    await expect(ticker.tick()).resolves.toBeUndefined();

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    consoleErrorSpy.mockRestore();
    db.close();
  });

  it("skips a tick that starts while the previous one is still running (concurrency guard)", async () => {
    insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);
    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));

    let resolveExecFile: (() => void) | undefined;
    const execFile = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExecFile = () => resolve({ stdout: "", stderr: "" });
        }),
    );
    const ticker = createTicker({ db, env, execFile });

    const first = ticker.tick();

    // Wait until the first tick is actually blocked inside `sendNotification`
    // (proven by execFile having been invoked) before starting the second,
    // instead of relying on microtask-ordering assumptions.
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));

    // A second tick started now (while the first is still in flight) must be
    // skipped entirely rather than running concurrently.
    await ticker.tick();
    expect(execFile).toHaveBeenCalledTimes(1);

    resolveExecFile?.();
    await first;

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    db.close();
  });

  it("continues processing the remaining firings when one firing fails (per-firing isolation)", async () => {
    // 2 タスクとも締切超過 + 着手済み（task_start あり・直近活動あり）にして、
    // deadline_overdue が 2 件だけ発火する状態を作る。
    // 勤務時間帯ゲートはローカル時刻基準のためモック時刻はローカルのまま、
    // due_at はモック時刻の 1 時間前（絶対時刻）にして TZ 非依存で「超過」を成立させる。
    const mockedNow = new Date("2026-07-05T09:31:00.000");
    const overdueDueAt = new Date(mockedNow.getTime() - 60 * 60 * 1000).toISOString();
    for (const title of ["資料A", "資料B"]) {
      const task = insertTask(db, {
        title,
        description: null,
        category: "work",
        priority: "high",
        due_at: overdueDueAt,
        status: "in_progress",
        boss_comment: null,
        estimated_minutes: null,
      });
      recordActivityEvent(db, { type: "task_start", task_id: task.id });
    }
    markTodaysMeetingsDone(db);
    vi.setSystemTime(mockedNow);

    // 1 件目の firing だけ DB 記録（insertNotification）を失敗させ、2 件目は
    // 実実装で成功させる。文面生成の失敗はもはや当該 firing 自体を失敗させ
    // ない（Issue #205: フォールバック文面で救済される）ため、per-firing
    // 分離（外側の try/catch）を検証するにはそれより後段の失敗を使う必要が
    // ある。
    insertNotificationMock.mockImplementationOnce(() => {
      throw new Error("insert boom");
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    await expect(ticker.tick()).resolves.toBeUndefined();

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe("deadline_overdue");
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("scheduler firing failed");
    consoleErrorSpy.mockRestore();
    db.close();
  });

  it("sends and records the notification using a fallback template when notification body generation itself throws (Issue #205)", async () => {
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: "high",
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: 30,
    });
    markTodaysMeetingsDone(db);
    vi.setSystemTime(new Date("2026-07-05T09:31:00.000"));

    // `generateNotificationBody` itself throws (distinct from its own
    // internal LLM-failure fallback, which is already exercised by every
    // other test in this file since no ANTHROPIC_API_KEY is ever injected).
    generateNotificationBodyMock.mockImplementationOnce(() => {
      throw new Error("body boom");
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    await expect(ticker.tick()).resolves.toBeUndefined();

    // `todo_stall` (mapped from `unstarted`) L1's fallback template
    // (notification-body.ts's `FALLBACK_TEMPLATES`), so the actually-sent
    // payload — not just the DB record — is pinned to the exact fallback
    // copy rather than merely asserting the flags were present.
    const fallbackBody = "そろそろ資料作成に着手しよう。";
    expect(execFile).toHaveBeenCalledWith(
      "terminal-notifier",
      expect.arrayContaining(["-title", "-message", fallbackBody]),
    );

    const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      type: "unstarted",
      rule_key: `unstarted:${task.id}`,
      escalation_level: 1,
      body: fallbackBody,
    });

    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("notification body generation threw");
    consoleErrorSpy.mockRestore();
    db.close();
  });

  it("logs and continues (does not throw) when an unexpected error occurs while building the tick input", async () => {
    db.close();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    await expect(ticker.tick()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  // GAP-02 / GAP-04 (#196, #239): 勤務時間帯外・休憩申告中の抑制を、個別ルール
  // 種別ごとに tick 経由（スケジューラ層）で検証する。rule-engine.test.ts が
  // 純粋関数レベルで既に担保している範囲を tick 経由でもなぞることで、
  // 「ゲートが本当にスケジューラ層まで貫通しているか」を確認する。
  describe("working-hours gate suppresses each rule type outside working hours (tick-level; GAP-02/GAP-04 per #196, #239)", () => {
    const WORKING_HOURS_BASE_TIME = new Date("2026-07-05T09:00:00.000");
    const OUTSIDE_WORKING_HOURS_BASE_TIME = new Date("2026-07-05T20:00:00.000");

    it.each(RULE_GATE_SCENARIOS.map((s) => [s.ruleType, s.setup] as const))(
      "fires %s within working hours (positive control) but suppresses it outside working hours",
      async (ruleType, setup) => {
        // Positive control: the exact same scenario, anchored inside working
        // hours, fires — this rules out "the scenario just never fires"
        // being the reason the outside-hours half below records nothing.
        // try/finally so a failure anywhere in this half (including `setup`
        // itself) still closes `db` (this test reuses beforeEach's `db` for
        // the first half only).
        try {
          const expectedRuleKey = setup(db, WORKING_HOURS_BASE_TIME);
          const withinExecFile = vi.fn().mockImplementation(ok);
          await createTicker({ db, env, execFile: withinExecFile }).tick();

          const firedWithin = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(firedWithin).toHaveLength(1);
          expect(firedWithin[0]).toMatchObject({ type: ruleType, rule_key: expectedRuleKey });
          expect(withinExecFile).toHaveBeenCalled();
        } finally {
          db.close();
        }

        // Same scenario, anchored outside working hours: the working-hours
        // gate must suppress it entirely. A separate db (rather than
        // reopening `db`) keeps this half's state fully independent of the
        // positive control above.
        const outsideDb = openDatabase(":memory:");
        try {
          runMigrations(outsideDb);
          setup(outsideDb, OUTSIDE_WORKING_HOURS_BASE_TIME);
          const outsideExecFile = vi.fn().mockImplementation(ok);
          await createTicker({ db: outsideDb, env, execFile: outsideExecFile }).tick();

          const firedOutside = listNotificationsSince(outsideDb, "1970-01-01T00:00:00.000Z");
          expect(firedOutside).toHaveLength(0);
          expect(outsideExecFile).not.toHaveBeenCalled();
        } finally {
          outsideDb.close();
        }
      },
    );
  });

  describe("break gate suppresses each rule type while a break is active (tick-level; GAP-04 per #196, #239; break_overrun excluded)", () => {
    const BASE_TIME = new Date("2026-07-05T09:00:00.000");

    // break_overrun is the one rule that is *supposed* to fire while on
    // break, so it is intentionally excluded from this suppression table
    // (it already has its own positive-control coverage in the
    // working-hours gate table above).
    const BREAK_GATED_RULE_SCENARIOS = RULE_GATE_SCENARIOS.filter(
      (s) => s.ruleType !== "break_overrun",
    );

    it.each(BREAK_GATED_RULE_SCENARIOS.map((s) => [s.ruleType, s.setup] as const))(
      "fires %s without an active break (positive control) but suppresses it while a break is active",
      async (ruleType, setup) => {
        // Positive control: no break declared, the scenario fires as usual.
        // try/finally so a failure anywhere in this half (including `setup`
        // itself) still closes `db`.
        try {
          const expectedRuleKey = setup(db, BASE_TIME);
          const withoutBreakExecFile = vi.fn().mockImplementation(ok);
          await createTicker({ db, env, execFile: withoutBreakExecFile }).tick();

          const firedWithoutBreak = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(firedWithoutBreak).toHaveLength(1);
          expect(firedWithoutBreak[0]).toMatchObject({
            type: ruleType,
            rule_key: expectedRuleKey,
          });
          expect(withoutBreakExecFile).toHaveBeenCalled();
        } finally {
          db.close();
        }

        // Same scenario, but a break is declared up front (with a generous
        // expected_minutes so break_overrun itself does not also fire and
        // muddy the "suppressed" count): the break gate must suppress it.
        // The break_start is recorded *before* `setup` runs, but its exact
        // position in activity_events cannot change the outcome: `!activeBreak`
        // gates the *entire* unstarted/avoidance/silence/deadline_overdue
        // block in evaluateRules unconditionally (rule-engine.ts), so none of
        // them are even evaluated once a break is active — regardless of
        // which activity events `setup` itself records (checkin/task_update/
        // none), *provided* `setup` never records its own break_start/
        // break_end (true for every BREAK_GATED_RULE_SCENARIOS entry — only
        // the excluded break_overrun scenario does that).
        const breakDb = openDatabase(":memory:");
        try {
          runMigrations(breakDb);
          vi.setSystemTime(BASE_TIME);
          recordActivityEvent(breakDb, {
            type: "break_start",
            expected_minutes: NEVER_OVERRUNNING_BREAK_MINUTES,
          });
          setup(breakDb, BASE_TIME);
          const withBreakExecFile = vi.fn().mockImplementation(ok);
          await createTicker({ db: breakDb, env, execFile: withBreakExecFile }).tick();

          const firedWithBreak = listNotificationsSince(breakDb, "1970-01-01T00:00:00.000Z");
          expect(firedWithBreak).toHaveLength(0);
          expect(withBreakExecFile).not.toHaveBeenCalled();
        } finally {
          breakDb.close();
        }
      },
    );
  });

  // GAP-24 (#196, #239): 朝会・夕会の定時催促は勤務時間帯ゲート・休憩ゲートの
  // 両方の外側にある（rule-engine.ts）。rule-engine.test.ts はこれを朝会側のみ
  // 純粋関数レベルで検証済みだが、夕会側・かつ tick 経由（スケジューラ層）の
  // 検証が無かった（本テストで解消）。
  describe("meeting reminders fire outside both gates via tick", () => {
    const MEETING_SETUP_TIME = new Date("2026-07-05T09:00:00.000");
    const OUTSIDE_WORKING_HOURS_AND_ON_BREAK_TIME = new Date("2026-07-05T20:05:00.000");

    // A discriminated union (not just `[SessionType, DetectionRuleType][]`)
    // so each session type can only pair with its own meeting rule — both
    // `["adhoc", "silence"]` (wrong session type) and `["morning", "silence"]`
    // (wrong rule for the session type) fail to type-check here.
    const MEETING_SCENARIOS: readonly (
      | readonly ["morning", "morning_meeting"]
      | readonly ["evening", "evening_meeting"]
    )[] = [
      ["morning", "morning_meeting"],
      ["evening", "evening_meeting"],
    ];

    it.each(MEETING_SCENARIOS)(
      "fires %s via tick even outside working hours and while on break, once the other meeting is already done",
      async (sessionType, ruleType) => {
        // try/finally (including the clock anchor and setup below) so a
        // failure anywhere in this test still closes `db` (consistent with
        // the two gate-suppression describes above).
        try {
          // Anchor the clock explicitly before seeding state (matching the
          // RULE_GATE_SCENARIOS convention) so the recorded session's
          // started_at does not implicitly depend on beforeEach's default
          // system time.
          vi.setSystemTime(MEETING_SETUP_TIME);
          // Mark the *other* meeting done so only the meeting under test can
          // fire (both default meeting times, 09:00/18:00, have already
          // passed by the tick time below).
          const otherSessionType: SessionType =
            sessionType === "morning" ? "evening" : "morning";
          insertSession(db, { type: otherSessionType });

          vi.setSystemTime(new Date("2026-07-05T19:50:00.000"));
          recordActivityEvent(db, {
            type: "break_start",
            expected_minutes: NEVER_OVERRUNNING_BREAK_MINUTES,
          });

          vi.setSystemTime(OUTSIDE_WORKING_HOURS_AND_ON_BREAK_TIME);
          const execFile = vi.fn().mockImplementation(ok);
          const ticker = createTicker({ db, env, execFile });

          await ticker.tick();

          const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(recorded).toHaveLength(1);
          expect(recorded[0]).toMatchObject({
            type: ruleType,
            rule_key: `${sessionType}_meeting:2026-07-05`,
          });
        } finally {
          db.close();
        }
      },
    );
  });
});
