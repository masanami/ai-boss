import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scheduleMock, tickMock, createTickerMock, sendNotificationMock, fakeExecFile } = vi.hoisted(
  () => ({
    scheduleMock: vi.fn(),
    tickMock: vi.fn().mockResolvedValue(undefined),
    createTickerMock: vi.fn(),
    sendNotificationMock: vi.fn(),
    fakeExecFile: vi.fn(),
  }),
);

// 実際の通知コマンド（terminal-notifier / osascript）を起動しない。
vi.mock("../notifications/notifier.js", () => ({
  sendNotification: sendNotificationMock,
  nodeSystemExecFile: fakeExecFile,
}));

vi.mock("node-cron", () => ({
  default: { schedule: scheduleMock },
  schedule: scheduleMock,
}));

vi.mock("./scheduler-tick.js", () => ({
  createTicker: createTickerMock,
}));

const { startScheduler } = await import("./scheduler.js");

describe("startScheduler", () => {
  const fakeTask = { stop: vi.fn(), start: vi.fn() };

  beforeEach(() => {
    scheduleMock.mockReset().mockReturnValue(fakeTask);
    tickMock.mockReset().mockResolvedValue(undefined);
    createTickerMock.mockReset().mockReturnValue({ tick: tickMock });
    fakeTask.stop.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a cron job that runs every minute", () => {
    startScheduler({ db: {} as never, env: {} });

    expect(scheduleMock).toHaveBeenCalledWith("* * * * *", expect.any(Function));
  });

  it("invokes the ticker's tick() from the scheduled callback", () => {
    startScheduler({ db: {} as never, env: {} });

    const [, callback] = scheduleMock.mock.calls[0] as [string, () => void];
    callback();

    expect(tickMock).toHaveBeenCalledTimes(1);
  });

  it("stop() stops the underlying cron task", () => {
    const handle = startScheduler({ db: {} as never, env: {} });

    handle.stop();

    expect(fakeTask.stop).toHaveBeenCalledTimes(1);
  });

  // #579 S3（機能仕様 docs/features/tauri-in-app-runtime.md AC-S3-21）
  it("AC-S3-21: passes the ticker a notification port that sends via notifier.ts's sendNotification with nodeSystemExecFile", async () => {
    const result = { delivered: true, channel: "terminal-notifier" };
    sendNotificationMock.mockReset().mockResolvedValue(result);

    startScheduler({ db: {} as never, env: {}, notificationUrl: "http://localhost:8787/" });

    const tickDeps = createTickerMock.mock.calls[0]![0] as {
      sendNotification: (payload: unknown) => Promise<unknown>;
      notificationUrl?: string;
    };
    const payload = { title: "ai-boss", body: "本文", url: "http://localhost:8787/" };
    await expect(tickDeps.sendNotification(payload)).resolves.toBe(result);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith(payload, { execFile: fakeExecFile });
    expect(tickDeps.notificationUrl).toBe("http://localhost:8787/");
  });
});
