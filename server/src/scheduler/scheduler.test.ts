import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { scheduleMock, tickMock, createTickerMock } = vi.hoisted(() => ({
  scheduleMock: vi.fn(),
  tickMock: vi.fn().mockResolvedValue(undefined),
  createTickerMock: vi.fn(),
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
});
