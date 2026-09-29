// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { bootProductApp, PRODUCT_DB_OPEN_FAILED_MESSAGE } from "./boot-product-app";
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

    const booting = bootProductApp({ installLlm: vi.fn(), openDb: () => opened.promise, logError: vi.fn(), installApi, render });
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

    await bootProductApp({ installLlm: vi.fn(), openDb: () => Promise.reject(failure), logError, installApi, render });

    expect(logError).toHaveBeenCalledWith(PRODUCT_DB_OPEN_FAILED_MESSAGE, failure);
    const app = installApi.mock.calls[0]![0];
    expect(await (await app.request("/api/health")).json()).toEqual({ status: "ok", db: false });
    expect(render).toHaveBeenCalledTimes(1);
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
    });
    expect(calls).toEqual(["installLlm", "openDb", "installApi", "render"]);
  });
});
