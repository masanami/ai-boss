import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import {
  findDecisionById,
  insertDecision,
  listDecisions,
  listRecentDecisions,
  updateDecisionStatus,
} from "./decisions-repository.js";

/** Raw-SQL helper for tests that need explicit control over `created_at`
 * (ordering assertions) — distinct from the `insertDecision` repository
 * function under test, which manages `created_at` itself. */
function insertRawDecision(
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
    insertRawDecision(db, session.id, "古い決定", "2026-07-01T00:00:00.000Z");
    insertRawDecision(db, session.id, "新しい決定", "2026-07-05T00:00:00.000Z");

    const result = listRecentDecisions(db, 5);

    expect(result).toEqual([
      { content: "新しい決定", decidedAt: "2026-07-05T00:00:00.000Z" },
      { content: "古い決定", decidedAt: "2026-07-01T00:00:00.000Z" },
    ]);
  });

  it("caps the result at the given limit, keeping the most recent ones", () => {
    const session = insertSession(db, { type: "adhoc" });
    for (let i = 0; i < 7; i++) {
      insertRawDecision(db, session.id, `決定${i}`, `2026-07-0${(i % 9) + 1}T00:00:00.000Z`);
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

describe("insertDecision", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts a decision with status 'active' and a server-managed created_at, defaulting task_id/rationale to null", () => {
    const session = insertSession(db, { type: "adhoc" });

    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    expect(decision).toMatchObject({
      session_id: session.id,
      task_id: null,
      content: "資料作成を最優先にする",
      rationale: null,
      status: "active",
    });
    expect(typeof decision.id).toBe("number");
    expect(typeof decision.created_at).toBe("string");
  });

  it("persists task_id and rationale when provided", () => {
    const session = insertSession(db, { type: "adhoc" });
    const task = insertTask(db, {
      title: "資料作成",
      description: null,
      category: "work",
      priority: null,
      due_at: null,
      status: "todo",
      boss_comment: null,
      estimated_minutes: null,
    });

    const decision = insertDecision(db, {
      session_id: session.id,
      task_id: task.id,
      content: "締切を延ばす",
      rationale: "他タスクが優先のため",
    });

    expect(decision).toMatchObject({
      task_id: task.id,
      content: "締切を延ばす",
      rationale: "他タスクが優先のため",
    });
  });

  it("persists the decision so it can be read back from the database", () => {
    const session = insertSession(db, { type: "adhoc" });

    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(decision.id);
    expect(row).toMatchObject({ content: "資料作成を最優先にする", status: "active" });
  });
});

describe("findDecisionById", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when no decision with the given id exists", () => {
    expect(findDecisionById(db, 9999)).toBeUndefined();
  });

  it("returns the decision when it exists", () => {
    const session = insertSession(db, { type: "adhoc" });
    const inserted = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    const found = findDecisionById(db, inserted.id);

    expect(found).toEqual(inserted);
  });
});

describe("updateDecisionStatus", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("updates the decision's status and returns the updated row", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    const updated = updateDecisionStatus(db, decision.id, "revised");

    expect(updated).toMatchObject({ id: decision.id, status: "revised" });
    expect(findDecisionById(db, decision.id)).toMatchObject({ status: "revised" });
  });

  it("returns undefined when no decision with the given id exists", () => {
    expect(updateDecisionStatus(db, 9999, "revised")).toBeUndefined();
  });
});

describe("listDecisions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when there are no decisions", () => {
    expect(listDecisions(db)).toEqual([]);
  });

  it("returns all decisions ordered by created_at descending", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertRawDecision(db, session.id, "古い決定", "2026-07-01T00:00:00.000Z");
    insertRawDecision(db, session.id, "新しい決定", "2026-07-05T00:00:00.000Z");

    const result = listDecisions(db);

    expect(result.map((decision) => decision.content)).toEqual([
      "新しい決定",
      "古い決定",
    ]);
  });
});
