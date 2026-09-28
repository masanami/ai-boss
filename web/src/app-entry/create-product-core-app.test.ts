// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createProductCoreApp } from "./create-product-core-app";
import { registeredCoreLlmBackendNames } from "../../../server/src/core-entry.js";

describe("createProductCoreApp", () => {
  it("answers GET /api/health with status 200 and {status:'ok', db:false} (DB 未接続)", async () => {
    const app = createProductCoreApp();
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: false });
  });

  it("does not answer 2xx for a DB-backed route (GET /api/tasks)", async () => {
    const app = createProductCoreApp();
    const response = await app.request("/api/tasks");

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("registers zero LLM backends after being loaded and used (オーナーの決定 Q4-c)", async () => {
    const app = createProductCoreApp();
    await app.request("/api/health");

    expect(registeredCoreLlmBackendNames()).toEqual([]);
  });
});
