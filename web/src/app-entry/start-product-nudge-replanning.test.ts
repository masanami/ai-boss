// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import productConfig from "../../vite.app.config";
import {
  isIosProductPlatform,
  NUDGE_REPLAN_INTERVAL_MS,
  startProductNudgeReplanning,
  type VisibilitySource,
} from "./start-product-nudge-replanning";

/**
 * 製品版の iOS の計画し直しの契機（#585 S3・機能仕様
 * docs/features/scheduled-nudges.md「製品版のエントリの配線」・受入基準（S3）
 * 「製品版のエントリの配線」）。`document` のイベントは模擬の購読で、タイマーは
 * Vitest の模擬のタイマーで進める。
 */

function fakeVisibility(initiallyVisible = true) {
  let visible = initiallyVisible;
  const handlers: Array<() => void> = [];
  const source: VisibilitySource = {
    isVisible: () => visible,
    onChange: (handler) => {
      handlers.push(handler);
    },
  };
  const change = (next: boolean) => {
    visible = next;
    for (const handler of handlers) handler();
  };
  return { source, change, handlers };
}

function start(initiallyVisible = true) {
  const requestReplan = vi.fn(async () => undefined);
  const visibility = fakeVisibility(initiallyVisible);
  startProductNudgeReplanning({
    replanner: { requestReplan },
    visibility: visibility.source,
    timers: {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
  });
  return { requestReplan, ...visibility };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startProductNudgeReplanning", () => {
  it("replans once at start", () => {
    const { requestReplan } = start();
    expect(requestReplan).toHaveBeenCalledTimes(1);
  });

  it("subscribes to visibility changes once", () => {
    const { handlers } = start();
    expect(handlers).toHaveLength(1);
  });

  it("replans when the app becomes visible", () => {
    const { requestReplan, change } = start(false);
    requestReplan.mockClear();
    change(true);
    expect(requestReplan).toHaveBeenCalledTimes(1);
  });

  it("does not replan when the app becomes hidden", () => {
    const { requestReplan, change } = start();
    requestReplan.mockClear();
    change(false);
    expect(requestReplan).not.toHaveBeenCalled();
  });

  it("the period is 15 minutes", () => {
    expect(NUDGE_REPLAN_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("after returning to the foreground, does not replan again at 14:59 and replans at 15:00", () => {
    const { requestReplan, change } = start(false);
    change(true);
    requestReplan.mockClear();
    vi.advanceTimersByTime(14 * 60_000 + 59_000);
    expect(requestReplan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(requestReplan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NUDGE_REPLAN_INTERVAL_MS);
    expect(requestReplan).toHaveBeenCalledTimes(2);
  });

  it("replans every 15 minutes while visible from the start", () => {
    const { requestReplan } = start(true);
    requestReplan.mockClear();
    vi.advanceTimersByTime(NUDGE_REPLAN_INTERVAL_MS - 1);
    expect(requestReplan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestReplan).toHaveBeenCalledTimes(1);
  });

  it("does not run the periodic replan after becoming hidden, even after 15 minutes or more", () => {
    const { requestReplan, change } = start(true);
    vi.advanceTimersByTime(10 * 60_000);
    change(false);
    requestReplan.mockClear();
    vi.advanceTimersByTime(3 * NUDGE_REPLAN_INTERVAL_MS);
    expect(requestReplan).not.toHaveBeenCalled();
  });

  it("does not start the periodic replan when started in the background", () => {
    const { requestReplan } = start(false);
    requestReplan.mockClear();
    vi.advanceTimersByTime(3 * NUDGE_REPLAN_INTERVAL_MS);
    expect(requestReplan).not.toHaveBeenCalled();
  });

  it("restarts the period from the return to the foreground (no doubled timers)", () => {
    const { requestReplan, change } = start(true);
    vi.advanceTimersByTime(10 * 60_000);
    change(false);
    change(true);
    change(true);
    requestReplan.mockClear();
    vi.advanceTimersByTime(NUDGE_REPLAN_INTERVAL_MS - 1);
    expect(requestReplan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestReplan).toHaveBeenCalledTimes(1);
  });
});

describe("isIosProductPlatform（仮定 A26）", () => {
  it.each([
    ["ios", true],
    ["darwin", false],
    ["android", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (platform, expected) => {
    expect(isIosProductPlatform(platform)).toBe(expected);
  });

  it("the product web build exposes TAURI_ENV_PLATFORM to import.meta.env", () => {
    const prefixes = [productConfig.envPrefix].flat();
    expect(prefixes.some((prefix) => prefix !== undefined && "TAURI_ENV_PLATFORM".startsWith(prefix))).toBe(true);
    expect(prefixes).not.toContain("TAURI_");
    expect(prefixes).not.toContain("");
  });
});
