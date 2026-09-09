import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { NewTaskRecord } from "../tasks/tasks-repository.js";
import {
  countMentoringDecisionsBySessionId,
  findDecisionById,
  insertDecision,
  listDecisions,
  listRecentDecisions,
} from "./decisions-repository.js";

/** Raw-SQL helper for tests that need explicit control over `created_at`
 * (ordering assertions) — distinct from the `insertDecision` repository
 * function under test, which manages `created_at` itself. `kind` defaults to
 * `'decision'` (the column's own DEFAULT) so existing callers are unaffected;
 * #408 tests pass `kind: "mentoring"` explicitly to build mixed fixtures. */
function insertRawDecision(
  db: Database.Database,
  sessionId: number,
  content: string,
  createdAt: string,
  taskId: number | null = null,
  kind: "decision" | "mentoring" = "decision",
): void {
  db.prepare(
    `INSERT INTO decisions (session_id, task_id, content, rationale, kind, status, created_at)
     VALUES (?, ?, ?, NULL, ?, 'active', ?)`,
  ).run(sessionId, taskId, content, kind, createdAt);
}

/** Minimal task fixture — only `title` matters to the decision log, the rest
 * are the columns `NewTaskRecord` requires. */
function newTask(title: string): NewTaskRecord {
  return {
    title,
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
  };
}

/** Builds a `created_at` value from a local wall-clock date, so ordering
 * fixtures stay meaningful in any timezone (ADR 0007 決定5). Deliberately
 * not a UTC string literal: the contract under test is the relative order
 * of records, which a fixed-offset literal would silently reinterpret. */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
): string {
  return new Date(year, month - 1, day, hour).toISOString();
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

  it("excludes kind='mentoring' rows, keeping only kind='decision' ones (#408 AC-42 — chat context must not surface mentoring as a decision)", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertRawDecision(
      db,
      session.id,
      "メンタリングの結論",
      "2026-07-05T00:00:00.000Z",
      null,
      "mentoring",
    );
    insertRawDecision(
      db,
      session.id,
      "通常の決定",
      "2026-07-01T00:00:00.000Z",
      null,
      "decision",
    );

    const result = listRecentDecisions(db, 5);

    expect(result.map((decision) => decision.content)).toEqual(["通常の決定"]);
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

  it("defaults kind to 'decision' (#358/#397 — 'mentoring' rows are written by #276, not here)", () => {
    const session = insertSession(db, { type: "adhoc" });

    const decision = insertDecision(db, {
      session_id: session.id,
      content: "資料作成を最優先にする",
    });

    expect(decision.kind).toBe("decision");
  });

  it("persists kind = 'mentoring' when explicitly passed (#276)", () => {
    const session = insertSession(db, { type: "adhoc" });

    const decision = insertDecision(db, {
      session_id: session.id,
      content: "進め方の点検結果",
      kind: "mentoring",
    });

    expect(decision.kind).toBe("mentoring");
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

  it("falls back to id descending when created_at ties", () => {
    const session = insertSession(db, { type: "adhoc" });
    const sameInstant = localIso(2026, 7, 5, 9);
    insertRawDecision(db, session.id, "先に入れた決定", sameInstant);
    insertRawDecision(db, session.id, "後に入れた決定", sameInstant);

    const result = listDecisions(db);

    // 同値のときは id 降順 = 後から入れたものが先（既存契約の維持）
    expect(result.map((decision) => decision.content)).toEqual([
      "後に入れた決定",
      "先に入れた決定",
    ]);
  });

  it("resolves the related task's title as task_title", () => {
    const session = insertSession(db, { type: "adhoc" });
    const task = insertTask(db, newTask("見積もり資料の作成"));
    insertRawDecision(
      db,
      session.id,
      "今日はこれを最優先で片付けろ",
      localIso(2026, 7, 5, 9),
      task.id,
    );

    const [decision] = listDecisions(db);

    expect(decision.task_id).toBe(task.id);
    expect(decision.task_title).toBe("見積もり資料の作成");
  });

  it("returns task_title = null for a decision with no task", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertRawDecision(
      db,
      session.id,
      "明日の朝会は 9:30 に変更する",
      localIso(2026, 7, 5, 18),
    );

    const [decision] = listDecisions(db);

    expect(decision.task_id).toBeNull();
    expect(decision.task_title).toBeNull();
  });

  it("carries kind so the screen can tell decisions from mentoring", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertRawDecision(db, session.id, "決定", localIso(2026, 7, 5, 9));

    const [decision] = listDecisions(db);

    expect(decision.kind).toBe("decision");
  });

  it("includes kind='mentoring' rows alongside kind='decision' rows (#408 AC-45 — the decision log is the reference screen and must not filter by kind)", () => {
    const session = insertSession(db, { type: "adhoc" });
    insertRawDecision(
      db,
      session.id,
      "メンタリングの結論",
      localIso(2026, 7, 5, 9),
      null,
      "mentoring",
    );
    insertRawDecision(
      db,
      session.id,
      "通常の決定",
      localIso(2026, 7, 5, 10),
      null,
      "decision",
    );

    const result = listDecisions(db);

    expect(result.map((decision) => decision.content)).toEqual([
      "通常の決定",
      "メンタリングの結論",
    ]);
    expect(result.map((decision) => decision.kind)).toEqual(["decision", "mentoring"]);
  });
});

// #276 判断3: 朝会終了ゲート（mentoring-gate.ts）が読む「対象セッションの
// kind='mentoring' 件数」。判定に使う純粋関数 isMentoringComplete への入力を
// 用意する側の責務であり、'decision' 行や他セッションの行を混ぜない。
describe("countMentoringDecisionsBySessionId", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 0 when the session has no decisions at all", () => {
    const session = insertSession(db, { type: "morning" });

    expect(countMentoringDecisionsBySessionId(db, session.id)).toBe(0);
  });

  it("counts only kind='mentoring' rows, excluding kind='decision' rows in the same session", () => {
    const session = insertSession(db, { type: "morning" });
    insertRawDecision(db, session.id, "通常の決定", localIso(2026, 7, 5, 9), null, "decision");
    insertRawDecision(
      db,
      session.id,
      "メンタリングの結論",
      localIso(2026, 7, 5, 10),
      null,
      "mentoring",
    );

    expect(countMentoringDecisionsBySessionId(db, session.id)).toBe(1);
  });

  it("excludes kind='mentoring' rows that belong to a different session", () => {
    const target = insertSession(db, { type: "morning" });
    const other = insertSession(db, { type: "morning" });
    insertRawDecision(
      db,
      other.id,
      "他セッションのメンタリング結論",
      localIso(2026, 7, 5, 9),
      null,
      "mentoring",
    );

    expect(countMentoringDecisionsBySessionId(db, target.id)).toBe(0);
  });

  it("counts multiple mentoring rows in the same session", () => {
    const session = insertSession(db, { type: "morning" });
    insertRawDecision(db, session.id, "結論1", localIso(2026, 7, 5, 9), null, "mentoring");
    insertRawDecision(db, session.id, "結論2", localIso(2026, 7, 5, 10), null, "mentoring");

    expect(countMentoringDecisionsBySessionId(db, session.id)).toBe(2);
  });
});
