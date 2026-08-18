import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./app.js";

describe("createApp", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 200 with status ok and db true from GET /api/health", async () => {
    const app = createApp(db);

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: true });
  });

  it("returns 404 for an unknown path", async () => {
    const app = createApp(db);

    const res = await app.request("/api/unknown");

    expect(res.status).toBe(404);
  });

  it("returns db: false when the database query fails", async () => {
    db.close();
    const app = createApp(db);

    const res = await app.request("/api/health");

    expect(await res.json()).toEqual({ status: "ok", db: false });
  });

  describe("static serving (staticRoot option)", () => {
    const staticRoot = mkdtempSync(join(tmpdir(), "ai-boss-web-dist-"));

    writeFileSync(join(staticRoot, "index.html"), "<html>ai-boss</html>");
    mkdirSync(join(staticRoot, "assets"));
    writeFileSync(join(staticRoot, "assets", "app.js"), "console.log('ok');");
    writeFileSync(join(staticRoot, "favicon.svg"), "<svg></svg>");
    writeFileSync(join(staticRoot, "manifest.webmanifest"), "{}");

    afterAll(() => {
      rmSync(staticRoot, { recursive: true, force: true });
    });

    it("serves index.html from GET /", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe("<html>ai-boss</html>");
    });

    it("serves an asset file with its content type", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/assets/app.js");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(await res.text()).toBe("console.log('ok');");
    });

    it("serves favicon.svg with an image/svg+xml content type", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/favicon.svg");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/svg+xml");
      expect(await res.text()).toBe("<svg></svg>");
    });

    it("serves manifest.webmanifest with an application/manifest+json content type", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/manifest.webmanifest");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/manifest+json");
      expect(await res.text()).toBe("{}");
    });

    it("falls back to index.html for an unknown non-API path (SPA routing)", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/some/spa/route");

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>ai-boss</html>");
    });

    it("still serves API routes with precedence over static files", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/api/health");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", db: true });
    });

    it("returns 404 for an unknown /api path instead of index.html", async () => {
      const app = createApp(db, process.env, { staticRoot });

      const res = await app.request("/api/unknown");

      expect(res.status).toBe(404);
    });
  });
});
