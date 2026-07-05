import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { listRecentDecisions } from "./decisions-repository.js";

function insertDecision(
  db: Database.Database,
  sessionId: number,
  content: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO decisions (session_id, task_id, content, rationale, status, created_at)
     VALUES (?, NULL, ?, NULL, 'active', ?)`,
  ).run(sessionId, content, createdAt);
}

describe("listRecentDecisions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when there are no decisions", () => {
    expect(listRecentDecisions(db, 5)).toEqual([]);
  });

  it("maps content and created_at to decidedAt, ordered most-recent first", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, session.id, "古い決定", "2026-07-01T00:00:00.000Z");
    insertDecision(db, session.id, "新しい決定", "2026-07-05T00:00:00.000Z");

    const result = listRecentDecisions(db, 5);

    expect(result).toEqual([
      { content: "新しい決定", decidedAt: "2026-07-05T00:00:00.000Z" },
      { content: "古い決定", decidedAt: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("caps the result at the given limit, keeping the most recent ones", () => {
    const session = insertSession(db, { type: "adhoc" });
    for (let i = 0; i < 7; i++) {
      insertDecision(db, session.id, `決定${i}`, `2026-07-0${(i % 9) + 1}T00:00:00.000Z`);
    }

    const result = listRecentDecisions(db, 5);

    expect(result.map((decision) => decision.content)).toEqual([
      "決定6",
      "決定5",
      "決定4",
      "決定3",
      "決定2",
    ]);
  });
});
