// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createProductNotificationPort, PRODUCT_NOTIFICATION_FAILED_MESSAGE } from "./product-notification-port";

/**
 * 製品版の通知ポート（#579 S3・機能仕様 docs/features/tauri-in-app-runtime.md
 * 「通知ポート」・受入基準（S3）AC-S3-22〜25）。`invoke` とログは注入し、
 * 実際の Tauri の IPC・OS の通知は使わない。
 */
describe("createProductNotificationPort", () => {
  it("AC-S3-22: calls invoke once with plugin:notification|notify and { options: { title, body } }", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const port = createProductNotificationPort({ invoke, logError: vi.fn() });

    await port({ title: "ai-boss", body: "資料作成を始めろ" });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", {
      options: { title: "ai-boss", body: "資料作成を始めろ" },
    });
  });

  it("does not forward the payload's url (notification click is not wired)", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const port = createProductNotificationPort({ invoke, logError: vi.fn() });

    await port({ title: "t", body: "b", url: "http://localhost:8787/" });

    expect(invoke).toHaveBeenCalledWith("plugin:notification|notify", {
      options: { title: "t", body: "b" },
    });
  });

  it("AC-S3-23: returns delivered:true on the tauri-notification channel when invoke resolves", async () => {
    const port = createProductNotificationPort({
      invoke: vi.fn().mockResolvedValue(undefined),
      logError: vi.fn(),
    });

    await expect(port({ title: "t", body: "b" })).resolves.toEqual({
      delivered: true,
      channel: "tauri-notification",
    });
  });

  it("AC-S3-24: returns delivered:false on the none channel instead of throwing when invoke rejects", async () => {
    const port = createProductNotificationPort({
      invoke: vi.fn().mockRejectedValue(new Error("not allowed")),
      logError: vi.fn(),
    });

    await expect(port({ title: "t", body: "b" })).resolves.toEqual({
      delivered: false,
      channel: "none",
    });
  });

  it("AC-S3-25: logs the failure (with the rejection) when invoke rejects", async () => {
    const failure = new Error("not allowed");
    const logError = vi.fn();
    const port = createProductNotificationPort({
      invoke: vi.fn().mockRejectedValue(failure),
      logError,
    });

    await port({ title: "t", body: "b" });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(PRODUCT_NOTIFICATION_FAILED_MESSAGE, failure);
  });

  it("does not log when invoke resolves", async () => {
    const logError = vi.fn();
    const port = createProductNotificationPort({
      invoke: vi.fn().mockResolvedValue(undefined),
      logError,
    });

    await port({ title: "t", body: "b" });

    expect(logError).not.toHaveBeenCalled();
  });
});
