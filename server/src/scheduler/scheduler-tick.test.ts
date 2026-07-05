import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "../tasks/tasks-repository.js";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { insertSession } from "../sessions/sessions-repository.js";
import type { SessionType } from "../sessions/session.js";
import { listNotificationsSince } from "../notifications/notifications-repository.js";

const { createClaudeClientMock, streamBossMessageMock, generateNotificationBodyMock } =
  vi.hoisted(() => ({
    createClaudeClientMock: vi.fn(),
    streamBossMessageMock: vi.fn(),
    generateNotificationBodyMock: vi.fn(),
  }));

vi.mock("../llm/claude-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/claude-client.js")>();
  return {
    ...actual,
    createClaudeClient: createClaudeClientMock,
    streamBossMessage: streamBossMessageMock,
  };
});

// per-firing 分離のテストで「1 件目の firing だけ失敗」を決定的に再現するため
// モック化する。既定（beforeEach）では実実装へ委譲するので他のテストの挙動は
// 変わらない。
vi.mock("../notifications/notification-body.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../notifications/notification-body.js")>();
  return {
    ...actual,
    generateNotificationBody: generateNotificationBodyMock,
  };
});

const { createTicker } = await import("./scheduler-tick.js");
const { MissingApiKeyError } = await import("../llm/claude-client.js");
const { generateNotificationBody: actualGenerateNotificationBody } =
  await vi.importActual<typeof import("../notifications/notification-body.js")>(
    "../notifications/notification-body.js",
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
 * template path.
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

describe("createTicker().tick", () => {
  let db: Database.Database;
  const env = {};

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    createClaudeClientMock.mockReset();
    streamBossMessageMock.mockReset();
    generateNotificationBodyMock.mockReset();
    createClaudeClientMock.mockImplementation(() => {
      throw new MissingApiKeyError();
    });
    generateNotificationBodyMock.mockImplementation(actualGenerateNotificationBody);

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

    // 1 件目の firing の文面生成だけ失敗させ、2 件目は実実装（定型文フォール
    // バック経路）で成功させる。
    generateNotificationBodyMock.mockImplementationOnce(() => {
      throw new Error("body boom");
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

  it("logs and continues (does not throw) when an unexpected error occurs while building the tick input", async () => {
    db.close();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execFile = vi.fn().mockImplementation(ok);
    const ticker = createTicker({ db, env, execFile });

    await expect(ticker.tick()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
