import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
