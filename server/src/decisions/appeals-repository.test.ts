import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertDecision } from "./decisions-repository.js";
import {
  insertAppeal,
  listAppealsByDecisionId,
  listAppealsGroupedByDecisionId,
} from "./appeals-repository.js";

describe("insertAppeal", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("inserts an appeal with a server-managed created_at and returns the persisted row", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    const appeal = insertAppeal(db, {
      decision_id: decision.id,
      content: "他の作業を優先させてほしい",
      verdict: "upheld",
      response: "決定は維持する",
    });

    expect(appeal).toMatchObject({
      decision_id: decision.id,
      content: "他の作業を優先させてほしい",
      verdict: "upheld",
      response: "決定は維持する",
    });
    expect(typeof appeal.id).toBe("number");
    expect(typeof appeal.created_at).toBe("string");
  });

  it("persists the appeal so it can be read back from the database", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    const appeal = insertAppeal(db, {
      decision_id: decision.id,
      content: "他の作業を優先させてほしい",
      verdict: "revised",
      response: "修正する",
    });

    const row = db.prepare("SELECT * FROM appeals WHERE id = ?").get(appeal.id);
    expect(row).toMatchObject({
      decision_id: decision.id,
      verdict: "revised",
      response: "修正する",
    });
  });
});

describe("listAppealsByDecisionId", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty array when the decision has no appeals", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    expect(listAppealsByDecisionId(db, decision.id)).toEqual([]);
  });

  it("returns only the appeals for the given decision, ordered by created_at ascending", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decisionA = insertDecision(db, {
      session_id: session.id,
      content: "決定A",
    });
    const decisionB = insertDecision(db, {
      session_id: session.id,
      content: "決定B",
    });

    insertAppeal(db, {
      decision_id: decisionA.id,
      content: "1つ目の進言",
      verdict: "upheld",
      response: "維持する",
    });
    insertAppeal(db, {
      decision_id: decisionA.id,
      content: "2つ目の進言",
      verdict: "revised",
      response: "修正する",
    });
    insertAppeal(db, {
      decision_id: decisionB.id,
      content: "別決定への進言",
      verdict: "upheld",
      response: "維持する",
    });

    const result = listAppealsByDecisionId(db, decisionA.id);

    expect(result.map((a) => a.content)).toEqual([
      "1つ目の進言",
      "2つ目の進言",
    ]);
  });
});

describe("listAppealsGroupedByDecisionId", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns an empty map when there are no appeals", () => {
    expect(listAppealsGroupedByDecisionId(db).size).toBe(0);
  });

  it("groups appeals by decision_id", () => {
    const session = insertSession(db, { type: "adhoc" });
    const decisionA = insertDecision(db, {
      session_id: session.id,
      content: "決定A",
    });
    const decisionB = insertDecision(db, {
      session_id: session.id,
      content: "決定B",
    });

    insertAppeal(db, {
      decision_id: decisionA.id,
      content: "1つ目の進言",
      verdict: "upheld",
      response: "維持する",
    });
    insertAppeal(db, {
      decision_id: decisionB.id,
      content: "別決定への進言",
      verdict: "upheld",
      response: "維持する",
    });

    const grouped = listAppealsGroupedByDecisionId(db);

    expect(grouped.get(decisionA.id)?.map((a) => a.content)).toEqual([
      "1つ目の進言",
    ]);
    expect(grouped.get(decisionB.id)?.map((a) => a.content)).toEqual([
      "別決定への進言",
    ]);
  });
});
