// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createProductCoreApp } from "./create-product-core-app";
import { createDisconnectedDbPort } from "./disconnected-db-port";
import { registeredCoreLlmBackendNames, type DbPort } from "../../../server/src/core-entry.js";

/** `SELECT 1` にだけ答える DB ポート（`/api/health` の DB 接続の確認用）。 */
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

describe("createProductCoreApp", () => {
  it("answers GET /api/health with {status:'ok', db:true} on a connected DB port (#580 S2)", async () => {
    const app = createProductCoreApp(portAnsweringSelectOne());
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: true });
  });

  it("answers GET /api/health with status 200 and {status:'ok', db:false} on the DB 未接続 port", async () => {
    const app = createProductCoreApp(createDisconnectedDbPort());
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: false });
  });

  it("does not answer 2xx for a DB-backed route (GET /api/tasks) on the DB 未接続 port", async () => {
    const app = createProductCoreApp(createDisconnectedDbPort());
    const response = await app.request("/api/tasks");

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("S2-E6: answers GET /api/llm-selection with 200 (the selection API is enabled for the product app)", async () => {
    const app = createProductCoreApp(portAnsweringSelectOne());
    const response = await app.request("/api/llm-selection");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { provider: unknown; model: unknown; catalog: unknown[] };
    expect(body.provider).toBeNull();
    expect(body.model).toBeNull();
    expect(body.catalog).toHaveLength(4);
  });

  it("registers zero LLM backends after being loaded and used (オーナーの決定 Q4-c)", async () => {
    const app = createProductCoreApp(createDisconnectedDbPort());
    await app.request("/api/health");

    expect(registeredCoreLlmBackendNames()).toEqual([]);
  });
});
