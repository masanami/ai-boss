// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../server/src/db/connection.js";
import { runMigrations } from "../../../server/src/db/migrate.js";
import { portFor } from "../../../server/src/db/test-support/port-for.js";
import type { DbPort } from "../../../server/src/core-entry.js";
import { bootProductApp, PRODUCT_NUDGE_REPLANNING_START_FAILED_MESSAGE } from "./boot-product-app";
import type { ProductCoreApp } from "./create-product-core-app";
import { NUDGE_NOTIFY_COMMAND } from "./product-nudge-scheduler-port";
import { selectProductNudgeReplanning, type ProductNudgeReplanning } from "./start-product-nudge-replanning";

/**
 * 製品版のエントリの配線（#585 S3・機能仕様 docs/features/scheduled-nudges.md
 * 「製品版のエントリの配線」・受入基準（S3）「製品版のエントリの配線」）。
 * プラットフォームの判定は `selectProductNudgeReplanning` に渡す値で差し替え
 * （仮定 A26）、`invoke`・`document` のイベント・タイマー・時刻・LLM は模擬にする。
 * DB は実際の SQLite（`:memory:`）。時刻はローカル日付で組む（ADR 0007）。
 */

const NOW = new Date(2026, 9, 2, 10, 0); // 金曜 10:00（ローカル）

async function migratedDb(): Promise<DbPort> {
  const db = portFor(openDatabase(":memory:"));
  await runMigrations(db);
  return db;
}

function fakeVisibility() {
  let visible = true;
  const handlers: Array<() => void> = [];
  return {
    source: {
      isVisible: () => visible,
      onChange: (handler: () => void) => {
        handlers.push(handler);
      },
    },
    change(next: boolean) {
      visible = next;
      for (const handler of handlers) handler();
    },
  };
}

function harness(platform: string | undefined) {
  const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => []);
  const visibility = fakeVisibility();
  const nudgeReplanning = selectProductNudgeReplanning(platform, {
    invoke,
    visibility: visibility.source,
    timers: { setInterval: () => 0, clearInterval: () => undefined },
    clock: () => NOW,
  });
  let app: ProductCoreApp | null = null;
  const startScheduler = vi.fn<(db: DbPort) => Promise<void>>().mockResolvedValue(undefined);
  const logError = vi.fn();
  const boot = (openDb: () => Promise<DbPort>) =>
    bootProductApp({
      installLlm: vi.fn(),
      openDb,
      logError,
      installApi: (installed) => {
        app = installed;
      },
      render: vi.fn(),
      startScheduler,
      nudgeReplanning,
    });
  const notifyCalls = () => invoke.mock.calls.filter(([command]) => command === NUDGE_NOTIFY_COMMAND);
  return { invoke, visibility, nudgeReplanning, startScheduler, logError, boot, notifyCalls, app: () => app! };
}

/** 計画し直しは応答を待たずに走るため、ポートへの呼び出しが落ち着くまで待つ */
async function settled(invoke: ReturnType<typeof vi.fn>): Promise<void> {
  let previous = -1;
  await vi.waitFor(async () => {
    const current = invoke.mock.calls.length;
    const stable = current === previous;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!stable) throw new Error("still changing");
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("iOS のとき", () => {
  it("replans once at startup after the DB is ready (reservations reach the port)", async () => {
    const h = harness("ios");
    await h.boot(migratedDb);
    await settled(h.invoke);
    expect(h.notifyCalls().length).toBeGreaterThan(0);
  });

  it("does not start the per-minute detection (does not subscribe to the tick event)", async () => {
    const h = harness("ios");
    await h.boot(migratedDb);
    await settled(h.invoke);
    expect(h.startScheduler).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("replans after a %s /api request", async (method) => {
    const h = harness("ios");
    await h.boot(migratedDb);
    await settled(h.invoke);
    h.invoke.mockClear();
    const response = await h.app().request("/api/tasks", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "報告書" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    await settled(h.invoke);
    expect(h.invoke).toHaveBeenCalled();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("does not replan after a %s /api request", async (method) => {
    const h = harness("ios");
    await h.boot(migratedDb);
    await settled(h.invoke);
    h.invoke.mockClear();
    await h.app().request("/api/tasks", { method });
    await settled(h.invoke);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("replans when the app becomes visible, and not when it becomes hidden", async () => {
    const h = harness("ios");
    await h.boot(migratedDb);
    await settled(h.invoke);
    h.invoke.mockClear();
    h.visibility.change(false);
    await settled(h.invoke);
    expect(h.invoke).not.toHaveBeenCalled();
    h.visibility.change(true);
    await settled(h.invoke);
    expect(h.invoke).toHaveBeenCalled();
  });

  it("does not replan when the DB could not be prepared (the port is never called)", async () => {
    const h = harness("ios");
    const createReplanner = vi.spyOn(h.nudgeReplanning!, "createReplanner");
    const start = vi.spyOn(h.nudgeReplanning!, "start");
    await h.boot(() => Promise.reject(new Error("migration failed")));
    expect(createReplanner).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await h.app().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "報告書" }),
    });
    h.visibility.change(true);
    await settled(h.invoke);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.startScheduler).not.toHaveBeenCalled();
  });

  it("creates the replanner before installing /api, and starts it after rendering", async () => {
    const calls: string[] = [];
    const db = await migratedDb();
    const requestReplan = vi.fn(async () => undefined);
    const nudgeReplanning: ProductNudgeReplanning = {
      createReplanner: () => {
        calls.push("createReplanner");
        return { requestReplan };
      },
      start: () => {
        calls.push("start");
      },
    };
    await bootProductApp({
      installLlm: vi.fn(),
      openDb: async () => db,
      logError: vi.fn(),
      installApi: () => calls.push("installApi"),
      render: () => calls.push("render"),
      startScheduler: vi.fn(),
      nudgeReplanning,
    });
    expect(calls).toEqual(["createReplanner", "installApi", "render", "start"]);
  });

  it.each(["createReplanner", "start"] as const)("logs a failure of %s and still renders", async (failing) => {
    const failure = new Error(`${failing} failed`);
    const render = vi.fn();
    const logError = vi.fn();
    const nudgeReplanning: ProductNudgeReplanning = {
      createReplanner: () => {
        if (failing === "createReplanner") throw failure;
        return { requestReplan: async () => undefined };
      },
      start: () => {
        if (failing === "start") throw failure;
      },
    };
    await expect(
      bootProductApp({
        installLlm: vi.fn(),
        openDb: migratedDb,
        logError,
        installApi: vi.fn(),
        render,
        startScheduler: vi.fn(),
        nudgeReplanning,
      }),
    ).resolves.toBeUndefined();
    expect(render).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(PRODUCT_NUDGE_REPLANNING_START_FAILED_MESSAGE, failure);
  });
});

describe("macOS のとき", () => {
  it("does not build the nudge replanning", () => {
    expect(harness("darwin").nudgeReplanning).toBeUndefined();
    expect(harness(undefined).nudgeReplanning).toBeUndefined();
  });

  it("starts the per-minute detection as before", async () => {
    const h = harness("darwin");
    await h.boot(migratedDb);
    expect(h.startScheduler).toHaveBeenCalledTimes(1);
  });

  it("does not call the scheduler port after a state-changing /api request", async () => {
    const h = harness("darwin");
    await h.boot(migratedDb);
    await h.app().request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "報告書" }),
    });
    h.visibility.change(true);
    await settled(h.invoke);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
