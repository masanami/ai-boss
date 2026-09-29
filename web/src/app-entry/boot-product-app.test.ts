// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  bootProductApp,
  PRODUCT_DB_OPEN_FAILED_MESSAGE,
  PRODUCT_SCHEDULER_START_FAILED_MESSAGE,
} from "./boot-product-app";
import type { ProductCoreApp } from "./create-product-core-app";
import type { DbPort } from "../../../server/src/core-entry.js";

/**
 * 製品版の web のエントリの起動の順序（#580 S2・機能仕様
 * docs/features/async-db-layer.md AC-S2-24・AC-S2-25）。
 */

function portAnsweringSelectOne(): DbPort {
  const port: DbPort = {
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    get: async <T,>() => ({ 1: 1 }) as T,
    all: async () => [],
    exec: async () => {},
    transaction: async (fn) => fn(port),
  };
  return port;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("bootProductApp", () => {
  it("AC-S2-24: DB の準備が終わるまで /api を振り向けず描画もしない。終わったら振り向けてから描画する", async () => {
    const opened = createDeferred<DbPort>();
    const calls: string[] = [];
    const installApi = vi.fn<(app: ProductCoreApp) => void>(() => {
      calls.push("installApi");
    });
    const render = vi.fn(() => {
      calls.push("render");
    });

    const booting = bootProductApp({
      installLlm: vi.fn(),
      openDb: () => opened.promise,
      logError: vi.fn(),
      installApi,
      render,
      startScheduler: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(installApi).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    opened.resolve(portAnsweringSelectOne());
    await booting;

    expect(calls).toEqual(["installApi", "render"]);
    const app = installApi.mock.calls[0]![0];
    expect(await (await app.request("/api/health")).json()).toEqual({ status: "ok", db: true });
  });

  it("AC-S2-25: DB の準備が失敗したら「DB 未接続」ポートで組み立て、失敗を記録して起動を続ける", async () => {
    const failure = new Error("migration failed");
    const logError = vi.fn();
    const installApi = vi.fn<(app: ProductCoreApp) => void>();
    const render = vi.fn();

    await bootProductApp({
      installLlm: vi.fn(),
      openDb: () => Promise.reject(failure),
      logError,
      installApi,
      render,
      startScheduler: vi.fn(),
    });

    expect(logError).toHaveBeenCalledWith(PRODUCT_DB_OPEN_FAILED_MESSAGE, failure);
    const app = installApi.mock.calls[0]![0];
    expect(await (await app.request("/api/health")).json()).toEqual({ status: "ok", db: false });
    expect(render).toHaveBeenCalledTimes(1);
  });

  // #579 S3（機能仕様 docs/features/tauri-in-app-runtime.md「起動の順序」・
  // 受入基準（S3）AC-S3-30〜33）。
  describe("毎分の検知の起動（#579 S3）", () => {
    it("AC-S3-30: DB の準備に成功したとき、そのポートで毎分の検知を始める", async () => {
      const port = portAnsweringSelectOne();
      const startScheduler = vi.fn<(db: DbPort) => Promise<void>>().mockResolvedValue(undefined);

      await bootProductApp({
        installLlm: vi.fn(),
        openDb: () => Promise.resolve(port),
        logError: vi.fn(),
        installApi: vi.fn(),
        render: vi.fn(),
        startScheduler,
      });

      expect(startScheduler).toHaveBeenCalledTimes(1);
      expect(startScheduler.mock.calls[0]![0]).toBe(port);
    });

    it("AC-S3-31: DB の準備に失敗して「DB 未接続」で起動したとき、毎分の検知を始めない", async () => {
      const startScheduler = vi.fn<(db: DbPort) => Promise<void>>().mockResolvedValue(undefined);
      const render = vi.fn();

      await bootProductApp({
        installLlm: vi.fn(),
        openDb: () => Promise.reject(new Error("migration failed")),
        logError: vi.fn(),
        installApi: vi.fn(),
        render,
        startScheduler,
      });

      expect(startScheduler).not.toHaveBeenCalled();
      expect(render).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["拒否する", () => Promise.reject(new Error("listen failed"))],
      ["同期的に投げる", () => { throw new Error("listen threw"); }],
    ])("AC-S3-32: 毎分の検知の開始が失敗しても（%s）、画面を描画する", async (_label, startScheduler) => {
      const render = vi.fn();

      await expect(
        bootProductApp({
          installLlm: vi.fn(),
          openDb: () => Promise.resolve(portAnsweringSelectOne()),
          logError: vi.fn(),
          installApi: vi.fn(),
          render,
          startScheduler,
        }),
      ).resolves.toBeUndefined();

      expect(render).toHaveBeenCalledTimes(1);
    });

    it("AC-S3-33: 毎分の検知の開始が失敗したとき、その失敗をログに出す", async () => {
      const failure = new Error("listen failed");
      const logError = vi.fn();

      await bootProductApp({
        installLlm: vi.fn(),
        openDb: () => Promise.resolve(portAnsweringSelectOne()),
        logError,
        installApi: vi.fn(),
        render: vi.fn(),
        startScheduler: () => Promise.reject(failure),
      });

      expect(logError).toHaveBeenCalledWith(PRODUCT_SCHEDULER_START_FAILED_MESSAGE, failure);
    });

    it("毎分の検知の開始が長引いても（未解決でも）、先に /api の振り向けと描画を済ませる", async () => {
      const calls: string[] = [];
      const booting = bootProductApp({
        installLlm: vi.fn(),
        openDb: () => Promise.resolve(portAnsweringSelectOne()),
        logError: vi.fn(),
        installApi: () => calls.push("installApi"),
        render: () => calls.push("render"),
        startScheduler: () => {
          calls.push("startScheduler");
          return new Promise<void>(() => undefined);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toEqual(["installApi", "render", "startScheduler"]);
      void booting;
    });
  });

  it("S3-E4（#581 S3）: 製品版の LLM の準備は /api の振り向けより前に行う", async () => {
    const calls: string[] = [];
    await bootProductApp({
      installLlm: () => calls.push("installLlm"),
      openDb: async () => {
        calls.push("openDb");
        return portAnsweringSelectOne();
      },
      logError: vi.fn(),
      installApi: () => calls.push("installApi"),
      render: () => calls.push("render"),
      startScheduler: vi.fn(),
    });
    expect(calls).toEqual(["installLlm", "openDb", "installApi", "render"]);
  });
});
