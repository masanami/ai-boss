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
import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "../activity/activity-event.js";
import { loadDetectionSettings } from "./detection-settings.js";

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
 * `from` から、`intervalMinutes`（`resolveEscalation` の間隔判定に使うエスカ
 * レーション間隔）の**内側**（`(0, intervalMinutes)`、両端を含まない）に収まる
 * オフセットだけ進めた `Date` を返す。`fraction`（0〜1）は間隔のどのあたりを
 * 狙うかの目安（例: 1/3 なら間隔の手前寄り）。
 *
 * `intervalMinutes >= 2` であれば `Math.max(1, …)` と
 * `Math.min(intervalMinutes - 1, …)` により必ず `[1, intervalMinutes - 1]`
 * の範囲（＝間隔の内側）に収める — 素朴に `interval * fraction` や
 * `interval - 5` を使うと、`intervalMinutes` が小さい設定値のときにオフセット
 * が 0 以下に潰れ、「間隔内だから抑制された／リセットされた」ではなく単に
 * 時刻が進んでいない（またはリセット対象の `sentAt` 以前に戻ってしまう）こと
 * で assertion が意味を失ったまま通ってしまう（`DEFAULT_DETECTION_SETTINGS`
 * の既定値 15 では問題にならないが、`settings` テーブル経由でより小さい値に
 * 上書きされた場合に備える）。`intervalMinutes <= 1` の場合は `[1,
 * intervalMinutes - 1]` という区間自体が空になるため、この関数は代わりに
 * `intervalMinutes` 以上のオフセットを返す（＝間隔の外側になる）。この分岐は
 * フェイルセーフ（意味を失ったまま assertion が通ってしまう側には倒れない）
 * ではあるが、呼び出し元によって具体的な結果は異なる: 重複抑制側の
 * assertion は（抑制されず次のレベルへ進んでしまうため）失敗する一方、
 * リセット側の assertion は `hasActivitySince` の厳密な `>` 比較により、
 * リセットが効いていない限りやはり失敗する（正当な理由で pass する場合と
 * 区別できる）。この呼び出し元が想定する `intervalMinutes`（既定 15）では
 * そもそも到達しないケース。
 */
function withinEscalationInterval(from: Date, intervalMinutes: number, fraction: number): Date {
  const offsetMinutes = Math.max(
    1,
    Math.min(intervalMinutes - 1, Math.round(intervalMinutes * fraction)),
  );
  return addMinutes(from, offsetMinutes);
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

  // GAP-01 (#196, #240): エスカレーションの L1 リセット（escalation.ts の
  // hasActivitySince）は活動シグナルの種別を問わない実装だが、既存の
  // "resets the escalation level to L1 after an activity signal is recorded"
  // は task_update 1 種のみを tick 経由で検証していた。他の種別でも同じ挙動に
  // なることをテーブル駆動で確認する。
  //
  // `break_start` は使わない（休憩ゲートが立ち unstarted 自体を抑制してしま
  // うため）。それ以外の ACTIVITY_EVENT_TYPES は `ACTIVITY_SIGNAL_TYPES` を
  // `ACTIVITY_EVENT_TYPES` からの導出（filter）にすることで構造的に全種を
  // 含む——RULE_GATE_SCENARIOS のような独立の手書きテーブルではないため、
  // 突き合わせる別ソースが無く、専用の網羅性ガードテストは書けない（書いても
  // 同じ式を2回評価するだけの恒真テストになる）。将来 break_start 以外にも
  // 除外が必要になった場合はこの filter 条件を更新すること。
  //
  // `task_start`/`task_pause` は `checkins-routes.ts` 経由（本番の唯一の記録
  // 経路）では、`task_id` が指すタスクの status を同一トランザクション内で
  // 遷移させる（task_start: todo/paused → in_progress、task_pause:
  // in_progress → paused）。ここでは unstarted シナリオ（トップタスクが
  // todo のまま）を土台に `recordActivityEvent` を直接呼ぶため、
  // `task_pause`（status が in_progress でなければ本番でも no-op）は本番と
  // 矛盾しないが、`task_start`（本番では必ず in_progress へ遷移する）は
  // 「task_start イベントは存在するが status は todo のまま」という、本番の
  // 呼び出し経路単体では作れない組み合わせになる。これは意図的な単純化: この
  // describe が検証したいのは `hasActivitySince`（escalation.ts）が活動シグ
  // ナルの種別を一切見ない、という repository レベルの挙動そのものであり、
  // `checkins-routes.ts` の status 遷移との整合は本テストのスコープ外
  // （プロダクションコード変更を伴う再設計は本チケット #240 の対象外）。
  describe("escalation reset to L1 is triggered by any activity signal type (tick-level; GAP-01 per #196, #240)", () => {
    const BASE_TIME = new Date("2026-07-05T09:00:00.000");
    // Manually maintained subset of ACTIVITY_SIGNAL_TYPES that must target the
    // top task's own id (see the `taskId` guard/usage below) rather than
    // `null` — i.e. every type `checkins-validation.ts` requires a `task_id`
    // for (`task_start`/`task_pause`) plus `task_update` (whose only
    // production source, `tasks-repository.ts`'s `updateTask`, always
    // targets a specific task). Not derived from a shared constant: unlike
    // `ACTIVITY_SIGNAL_TYPES` below, "does this event type carry a task_id
    // in practice" isn't expressed anywhere else in the codebase as a single
    // exhaustive list, so there is nothing structural to derive this from. If
    // a future ActivityEventType gains task-id semantics, add it here too.
    const TASK_SCOPED_ACTIVITY_TYPES: ActivityEventType[] = ["task_start", "task_update", "task_pause"];
    // Derived (not a hand-maintained literal) from ACTIVITY_EVENT_TYPES so
    // that adding a new ActivityEventType automatically gains coverage here
    // — this makes exhaustiveness structural rather than something a
    // separate runtime test could verify (a test asserting this filter
    // equals itself would be tautological).
    const ACTIVITY_SIGNAL_TYPES: ActivityEventType[] = ACTIVITY_EVENT_TYPES.filter(
      (type) => type !== "break_start",
    );

    it.each(ACTIVITY_SIGNAL_TYPES)(
      "resets the escalation level to L1 after a %s activity signal is recorded",
      async (activityType) => {
        const unstartedScenario = RULE_GATE_SCENARIOS.find((s) => s.ruleType === "unstarted");
        if (!unstartedScenario) {
          throw new Error("expected an 'unstarted' scenario in RULE_GATE_SCENARIOS");
        }
        try {
          // `task_update`/`task_start`/`task_pause` must target the top
          // task's own id (not some other task) — otherwise
          // `hasRecentActivityOnOtherTasks` would flip the rule from
          // `unstarted` to `avoidance`, changing `rule_key`.
          const expectedRuleKey = unstartedScenario.setup(db, BASE_TIME);
          const taskId = Number(expectedRuleKey.split(":")[1]);
          if (!Number.isInteger(taskId)) {
            throw new Error(
              `expected the unstarted scenario's rule_key ("${expectedRuleKey}") to end with a numeric task id`,
            );
          }

          const execFile = vi.fn().mockImplementation(ok);
          const ticker = createTicker({ db, env, execFile });

          // First tick: L1 fires (the scenario's setup already advanced the
          // clock past the unstarted threshold).
          await ticker.tick();

          // Record the activity signal, then re-tick, both strictly *within*
          // the L1->L2 escalation interval. Without the reset,
          // resolveEscalation's interval check alone would suppress this
          // second tick entirely (duplicate prevention) — so a level-1
          // second notification proves the *reset* (not merely "an interval
          // elapsed") caused it. The interval is read via the same
          // `loadDetectionSettings` the scheduler itself uses (not the
          // hardcoded default), so this stays correct even if `settings`
          // ever overrides it.
          const interval = loadDetectionSettings(db).escalation.level1ToLevel2Minutes;
          const fireTime = vi.getMockedSystemTime();
          if (!fireTime) throw new Error("expected the system clock to be faked");

          vi.setSystemTime(withinEscalationInterval(fireTime, interval, 1 / 3));
          recordActivityEvent(db, {
            type: activityType,
            task_id: TASK_SCOPED_ACTIVITY_TYPES.includes(activityType) ? taskId : null,
          });

          vi.setSystemTime(withinEscalationInterval(fireTime, interval, 2 / 3));
          await ticker.tick();

          const recorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(recorded).toHaveLength(2);
          expect(recorded[1]).toMatchObject({
            escalation_level: 1,
            rule_key: expectedRuleKey,
          });
        } finally {
          db.close();
        }
      },
    );
  });

  // GAP-03 + GAP-06 (#196, #240): 未着手 (`unstarted`) 以外のルール種別でも
  // エスカレーション間隔内の重複送信防止が tick 経由で効くこと、および
  // 全ルール種別で一貫した `rule_key`（重複防止キー）と検知語彙の `type` が
  // 記録されることを、RULE_GATE_SCENARIOS を再利用してテーブル駆動で検証する。
  // 朝会・夕会の rule_key は「meeting reminders fire outside both gates via
  // tick」で既に検証済みのため、ここでは重複して書かない（DRY）。
  //
  // L1→L2 のエスカレーション「昇格」自体（間隔経過後に次のレベルへ進むこと）
  // の tick 経由での検証は、本チケット #240 の対象外（#241 の担当範囲。チケッ
  // ト本文の「対象外スコープ」参照）。ここで検証するのは「間隔未経過では発火
  // しない」（重複送信防止）ことのみ。
  describe("duplicate suppression and rule_key consistency across rule types (tick-level; GAP-03/GAP-06 per #196, #240)", () => {
    const BASE_TIME = new Date("2026-07-05T09:00:00.000");

    it.each(RULE_GATE_SCENARIOS.map((s) => [s.ruleType, s.setup] as const))(
      "records %s once with its expected rule_key/type, then suppresses a duplicate within the escalation interval",
      async (ruleType, setup) => {
        try {
          const expectedRuleKey = setup(db, BASE_TIME);
          const execFile = vi.fn().mockImplementation(ok);
          const ticker = createTicker({ db, env, execFile });

          await ticker.tick();

          const firstRecorded = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(firstRecorded).toHaveLength(1);
          expect(firstRecorded[0]).toMatchObject({
            type: ruleType,
            rule_key: expectedRuleKey,
            escalation_level: 1,
          });

          // Re-tick strictly *within* the L1->L2 escalation interval without
          // recording any new activity signal, so it is resolveEscalation's
          // interval check (not the hasActivitySince reset) that is under
          // test here. Interval read via loadDetectionSettings(db) — see the
          // comment on the GAP-01 describe above for why.
          const interval = loadDetectionSettings(db).escalation.level1ToLevel2Minutes;
          const fireTime = vi.getMockedSystemTime();
          if (!fireTime) throw new Error("expected the system clock to be faked");
          vi.setSystemTime(withinEscalationInterval(fireTime, interval, 1 / 2));
          await ticker.tick();

          const afterDuplicateTick = listNotificationsSince(db, "1970-01-01T00:00:00.000Z");
          expect(afterDuplicateTick).toHaveLength(1);
        } finally {
          db.close();
        }
      },
    );
  });
});
