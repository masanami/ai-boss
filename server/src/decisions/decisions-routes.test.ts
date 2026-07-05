import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertDecision } from "./decisions-repository.js";
import type { Decision } from "./decision.js";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/decisions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when there are no decisions", async () => {
    const app = createApp(db);

    const res = await app.request("/api/decisions");

    expect(res.status).toBe(200);
    expect(await readJson<Decision[]>(res)).toEqual([]);
  });

  it("returns decisions ordered by created_at descending", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, { session_id: session.id, content: "1つ目の決定" });
    insertDecision(db, { session_id: session.id, content: "2つ目の決定" });

    const res = await app.request("/api/decisions");

    expect(res.status).toBe(200);
    const body = await readJson<Decision[]>(res);
    expect(body.map((d) => d.content)).toEqual(["2つ目の決定", "1つ目の決定"]);
  });
});
