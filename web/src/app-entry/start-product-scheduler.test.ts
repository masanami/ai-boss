// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../server/src/db/connection.js";
import { runMigrations } from "../../../server/src/db/migrate.js";
import { portFor } from "../../../server/src/db/test-support/port-for.js";
import type { DbPort } from "../../../server/src/core-entry.js";
import { PRODUCT_NOTIFICATION_COMMAND } from "./product-notification-port";

// `createTicker` は既定では本物へ委譲する（AC-S3-28 は本物の検知を回す）。
// AC-S3-27・AC-S3-29 だけが、受け取った依存の検査と `tick` の差し替えのために
// 一時的に置き換える。
const { createTickerSpy } = vi.hoisted(() => ({ createTickerSpy: vi.fn() }));
vi.mock("../../../server/src/core-entry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../server/src/core-entry.js")>();
  createTickerSpy.mockImplementation(actual.createTicker);
  return { ...actual, createTicker: createTickerSpy };
});

const { startProductScheduler, MINUTE_TICK_EVENT } = await import("./start-product-scheduler");
const actualCore = await vi.importActual<typeof import("../../../server/src/core-entry.js")>(
  "../../../server/src/core-entry.js",
);

/**
 * 製品版の毎分の検知の起動（#579 S3・機能仕様
 * docs/features/tauri-in-app-runtime.md「起動の順序」・受入基準（S3）
 * AC-S3-26〜29）。`listen`・`invoke` は注入し、Tauri の IPC も OS の通知も
 * 使わない。時刻はローカル日付で組む（ADR 0007）。
 */

type Handler = () => void;

function fakeListen() {
  const handlers: Handler[] = [];
  const unlisten = vi.fn();
  const listen = vi.fn(async (_event: string, handler: Handler) => {
    handlers.push(handler);
    return unlisten;
  });
  return { listen, handlers, unlisten };
}

beforeEach(() => {
  createTickerSpy.mockReset().mockImplementation(actualCore.createTicker);
});

describe("startProductScheduler", () => {
  const fakeDb = {} as DbPort;

  it("AC-S3-26: subscribes to the minute-tick event exactly once", async () => {
    const { listen } = fakeListen();

    await startProductScheduler({ db: fakeDb, listen, invoke: vi.fn(), logError: vi.fn() });

    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]![0]).toBe("minute-tick");
    expect(MINUTE_TICK_EVENT).toBe("minute-tick");
  });

  it("AC-S3-27: runs the ticker's tick once per received event (and not before any event)", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    createTickerSpy.mockReturnValue({ tick });
    const { listen, handlers } = fakeListen();

    await startProductScheduler({ db: fakeDb, listen, invoke: vi.fn(), logError: vi.fn() });
    expect(tick).not.toHaveBeenCalled();

    handlers[0]!();
    expect(tick).toHaveBeenCalledTimes(1);
    handlers[0]!();
    handlers[0]!();
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("AC-S3-29: builds the ticker with an empty env (no key at all)", async () => {
    const { listen } = fakeListen();

    await startProductScheduler({ db: fakeDb, listen, invoke: vi.fn(), logError: vi.fn() });

    expect(createTickerSpy).toHaveBeenCalledTimes(1);
    const deps = createTickerSpy.mock.calls[0]![0] as { env: Record<string, unknown>; db: DbPort };
    expect(Object.keys(deps.env)).toEqual([]);
    expect(deps.db).toBe(fakeDb);
  });

  it("rejects when the subscription fails (the caller decides how to report it)", async () => {
    const failure = new Error("listen failed");
    const listen = vi.fn().mockRejectedValue(failure);

    await expect(
      startProductScheduler({ db: fakeDb, listen, invoke: vi.fn(), logError: vi.fn() }),
    ).rejects.toBe(failure);
  });
});

describe("startProductScheduler with a real DB", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("AC-S3-28: a firing writes its notification row to the DB port passed at start, and sends via the product port", async () => {
    const raw = openDatabase(":memory:");
    try {
      const db = portFor(raw);
      await runMigrations(db);
      // 朝会の時刻（既定）を過ぎ、朝会が未実施のときの朝会のリマインド（1 件）。
      vi.setSystemTime(new Date(2026, 6, 5, 10, 30));
      const { listen, handlers } = fakeListen();
      const invoke = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await startProductScheduler({ db, listen, invoke, logError: vi.fn() });
      handlers[0]!();
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => {
        const rows = raw.prepare("SELECT delivered, channel, rule_key FROM notifications").all();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ delivered: 1, channel: "tauri-notification" });
      });

      expect(invoke).toHaveBeenCalledWith(PRODUCT_NOTIFICATION_COMMAND, {
        options: { title: expect.any(String), body: expect.any(String) },
      });
    } finally {
      raw.close();
    }
  });
});
