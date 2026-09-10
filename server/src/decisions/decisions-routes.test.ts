import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createApp } from "../app.js";
import { insertSession } from "../sessions/sessions-repository.js";
import { insertTask } from "../tasks/tasks-repository.js";
import type { NewTaskRecord } from "../tasks/tasks-repository.js";
import { insertDecision } from "./decisions-repository.js";
import type { DecisionListItem } from "./decision.js";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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
    expect(await readJson<DecisionListItem[]>(res)).toEqual([]);
  });

  // Issue #461（親 #446 S1）: 決定ログは正規化の対象外（機能仕様「やらないこと」
  // 「決定ログ（record_decision）・作業ログの表示への正規化の適用」）。
  // 恒真テストにならないよう、正規化を適用すれば実際に変化する HTML タグ
  // （<p> <strong>）を含む content で、保存値との一致を直接アサートする。
  it("AC-19: returns the decision content exactly as stored, without applying HTML-tag normalization", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    const rawContent = "<p>資料作成を優先しろ</p><strong>今日中に</strong>。";
    insertDecision(db, { session_id: session.id, content: rawContent });

    const res = await app.request("/api/decisions");

    const [decision] = await readJson<DecisionListItem[]>(res);
    expect(decision.content).toBe(rawContent);
  });

  it("returns decisions ordered by created_at descending", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, { session_id: session.id, content: "1つ目の決定" });
    insertDecision(db, { session_id: session.id, content: "2つ目の決定" });

    const res = await app.request("/api/decisions");

    expect(res.status).toBe(200);
    const body = await readJson<DecisionListItem[]>(res);
    expect(body.map((d) => d.content)).toEqual(["2つ目の決定", "1つ目の決定"]);
  });

  it("carries the related task's title as task_title", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    const task = insertTask(db, newTask("見積もり資料の作成"));
    insertDecision(db, {
      session_id: session.id,
      task_id: task.id,
      content: "今日はこれを最優先で片付けろ",
    });

    const res = await app.request("/api/decisions");

    const [decision] = await readJson<DecisionListItem[]>(res);
    expect(decision.task_id).toBe(task.id);
    expect(decision.task_title).toBe("見積もり資料の作成");
  });

  it("returns task_title = null for a decision with no task", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, {
      session_id: session.id,
      content: "明日の朝会は 9:30 に変更する",
    });

    const res = await app.request("/api/decisions");

    const [decision] = await readJson<DecisionListItem[]>(res);
    expect(decision.task_id).toBeNull();
    expect(decision.task_title).toBeNull();
  });

  it("exposes kind and no longer exposes an appeals field", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    insertDecision(db, { session_id: session.id, content: "決定内容" });

    const res = await app.request("/api/decisions");

    const [decision] = await readJson<DecisionListItem[]>(res);
    expect(decision.kind).toBe("decision");
    // 進言の削除（#358/#397）で `appeals` フィールドは応答から消えた
    expect(decision).not.toHaveProperty("appeals");
  });
});

describe("POST /api/decisions/:id/appeals", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 404 — the appeals route was removed (#358/#397)", async () => {
    const app = createApp(db);
    const session = insertSession(db, { type: "adhoc" });
    const decision = insertDecision(db, { session_id: session.id, content: "決定内容" });

    const res = await app.request(`/api/decisions/${decision.id}/appeals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "異議あり" }),
    });

    expect(res.status).toBe(404);
  });
});
