// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createProductNudgeSchedulerPort,
  NUDGE_CANCEL_COMMAND,
  NUDGE_GET_PENDING_COMMAND,
  NUDGE_NOTIFY_COMMAND,
} from "./product-nudge-scheduler-port";

/**
 * 製品版の通知の予約ポート（#585 S3・機能仕様 docs/features/scheduled-nudges.md
 * 「通知の予約ポートの実装（製品版）」・受入基準（S3）「通知の予約ポート（製品版）」）。
 * `invoke` と時刻は注入し、Tauri の IPC も OS の通知も使わない。
 *
 * 時刻は明示した時間帯（`Asia/Tokyo`・UTC+9。夏時間なし）の壁時計から組み、
 * 実行環境の時間帯に依存させない（`npm run test:tz` でも同じ結果になる）。
 */

/** `Asia/Tokyo` の壁時計の時刻（UTC+9 固定） */
function tokyo(year: number, month: number, day: number, hour: number, minute = 0, second = 0, ms = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second, ms));
}

const NOW = tokyo(2026, 10, 2, 8, 30);

function setup(invokeImpl: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async () => 1) {
  const invoke = vi.fn(invokeImpl);
  const port = createProductNudgeSchedulerPort({ invoke, clock: () => NOW });
  return { invoke, port };
}

function notifyOptions(invoke: ReturnType<typeof setup>["invoke"]) {
  const args = invoke.mock.calls[0]![1] as {
    options: {
      id: number;
      title: string;
      body: string;
      schedule: { at: { date: string; repeating: boolean; allowWhileIdle: boolean } };
    };
  };
  return args.options;
}

const REQUEST = { id: 42, at: tokyo(2026, 10, 2, 9, 0), title: "ボス", body: "報告しろ" };

describe("createProductNudgeSchedulerPort", () => {
  describe("register", () => {
    it("calls plugin:notification|notify exactly once", async () => {
      const { invoke, port } = setup();
      await port.register(REQUEST);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]![0]).toBe("plugin:notification|notify");
      expect(NUDGE_NOTIFY_COMMAND).toBe("plugin:notification|notify");
    });

    it("passes the request's id, title and body", async () => {
      const { invoke, port } = setup();
      await port.register(REQUEST);
      const options = notifyOptions(invoke);
      expect(options.id).toBe(42);
      expect(options.title).toBe("ボス");
      expect(options.body).toBe("報告しろ");
    });

    it("passes the scheduled time as a UTC ISO 8601 string ending in Z (Asia/Tokyo 2026-10-02 09:00 → 2026-10-02T00:00:00.000Z)", async () => {
      const { invoke, port } = setup();
      await port.register(REQUEST);
      const { date } = notifyOptions(invoke).schedule.at;
      expect(date).toBe("2026-10-02T00:00:00.000Z");
      expect(new Date(date).getTime()).toBe(REQUEST.at.getTime());
    });

    it("schedules a one-shot notification (repeating = false)", async () => {
      const { invoke, port } = setup();
      await port.register(REQUEST);
      expect(notifyOptions(invoke).schedule.at.repeating).toBe(false);
      expect(notifyOptions(invoke).schedule.at.allowWhileIdle).toBe(false);
    });

    it.each([
      ["4,999 ms after now", 4_999],
      ["exactly now", 0],
      ["before now", -60_000],
    ])("moves a scheduled time %s to 5,000 ms after now", async (_label, offsetMs) => {
      const { invoke, port } = setup();
      await port.register({ ...REQUEST, at: new Date(NOW.getTime() + offsetMs) });
      expect(notifyOptions(invoke).schedule.at.date).toBe(new Date(NOW.getTime() + 5_000).toISOString());
    });

    it("keeps a scheduled time exactly 5,000 ms after now", async () => {
      const { invoke, port } = setup();
      await port.register({ ...REQUEST, at: new Date(NOW.getTime() + 5_000) });
      expect(notifyOptions(invoke).schedule.at.date).toBe(new Date(NOW.getTime() + 5_000).toISOString());
    });

    it("keeps a scheduled time 5,001 ms after now as it is", async () => {
      const { invoke, port } = setup();
      await port.register({ ...REQUEST, at: new Date(NOW.getTime() + 5_001) });
      expect(notifyOptions(invoke).schedule.at.date).toBe(new Date(NOW.getTime() + 5_001).toISOString());
    });

    it("reads now from the clock at each registration", async () => {
      let now = NOW;
      const invoke = vi.fn(async () => 1);
      const port = createProductNudgeSchedulerPort({ invoke, clock: () => now });
      now = new Date(NOW.getTime() + 60_000);
      await port.register({ ...REQUEST, at: NOW });
      const args = invoke.mock.calls[0] as unknown as [string, { options: { schedule: { at: { date: string } } } }];
      expect(args[1].options.schedule.at.date).toBe(new Date(now.getTime() + 5_000).toISOString());
    });

    it("rejects when invoke rejects", async () => {
      const failure = new Error("Scheduled time must be *after* current time");
      const { port } = setup(() => Promise.reject(failure));
      await expect(port.register(REQUEST)).rejects.toBe(failure);
    });

    it.each([
      [0, false],
      [1, true],
      [2_147_483_647, true],
      [2_147_483_648, false],
      [-1, false],
      [1.5, false],
    ])("with id %d registers = %s (ids outside 1..2,147,483,647 reject without calling invoke)", async (id, registers) => {
      const { invoke, port } = setup();
      const result = port.register({ ...REQUEST, id });
      if (registers) {
        await expect(result).resolves.toBeUndefined();
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(notifyOptions(invoke).id).toBe(id);
      } else {
        await expect(result).rejects.toThrow(RangeError);
        expect(invoke).not.toHaveBeenCalled();
      }
    });
  });

  describe("cancel", () => {
    it("calls plugin:notification|cancel once with only that id", async () => {
      const { invoke, port } = setup();
      await port.cancel(42);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("plugin:notification|cancel", { notifications: [42] });
      expect(NUDGE_CANCEL_COMMAND).toBe("plugin:notification|cancel");
    });

    it("rejects when invoke rejects", async () => {
      const failure = new Error("not allowed");
      const { port } = setup(() => Promise.reject(failure));
      await expect(port.cancel(42)).rejects.toBe(failure);
    });
  });

  it("declares that registering the same id replaces the existing reservation", () => {
    expect(setup().port.replacesSameId).toBe(true);
  });

  describe("countPending", () => {
    it("calls plugin:notification|get_pending and returns the number of pending notifications", async () => {
      const pending = [
        { id: 1, title: "a", body: "x" },
        { id: 2, title: "b", body: "y" },
        { id: 3, title: "c", body: "z" },
      ];
      const { invoke, port } = setup(async () => pending);
      await expect(port.countPending!()).resolves.toBe(3);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]![0]).toBe("plugin:notification|get_pending");
      expect(NUDGE_GET_PENDING_COMMAND).toBe("plugin:notification|get_pending");
    });

    it("returns 0 for an empty list", async () => {
      const { port } = setup(async () => []);
      await expect(port.countPending!()).resolves.toBe(0);
    });

    it("rejects when invoke rejects", async () => {
      const failure = new Error("not allowed");
      const { port } = setup(() => Promise.reject(failure));
      await expect(port.countPending!()).rejects.toBe(failure);
    });

    it("rejects when the result is not a list", async () => {
      const { port } = setup(async () => null);
      await expect(port.countPending!()).rejects.toThrow(TypeError);
    });
  });
});
