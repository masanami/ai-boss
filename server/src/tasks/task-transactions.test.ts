import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { DbPort } from "../db/db-port.js";
import { createHookedTestDb } from "../db/test-support/create-test-db.js";
import type { DriverHook } from "../db/test-support/hooked-driver.js";
import { createTasksRouter } from "./tasks-routes.js";
import { createCheckinsRouter } from "../activity/checkins-routes.js";
import { updateTask } from "./tasks-repository.js";

// #604・機能仕様 docs/features/async-db-layer.md 決定 2（T2・T3・E1）:
// フック付きドライバで「判定の読み出しの直後」に別の流れを差し込み、割り込みを
// 決定的に作る（壁時計の待ち時間に頼らない）。

const TASK_READ = "SELECT * FROM tasks WHERE id = ?";

interface Harness {
  db: DbPort;
  raw: Database.Database;
  hooks: DriverHook[];
  app: Hono;
}

const opened: Database.Database[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const raw of opened.splice(0)) {
    raw.close();
  }
});

async function setup(): Promise<Harness> {
  const { db, raw, hooks } = await createHookedTestDb();
  opened.push(raw);
  const app = new Hono();
  app.route("/api/tasks", createTasksRouter(db));
  app.route("/api/checkins", createCheckinsRouter(db));
  return { db, raw, hooks, app };
}

function insertRawTask(
  raw: Database.Database,
  fields: { status: string; evidenceRequired?: boolean; title?: string },
): number {
  const now = new Date().toISOString();
  const result = raw
    .prepare(
      `INSERT INTO tasks (title, category, status, created_at, updated_at, evidence_required)
       VALUES (?, 'work', ?, ?, ?, ?)`,
    )
    .run(fields.title ?? "資料作成", fields.status, now, now, fields.evidenceRequired ? 1 : 0);
  return Number(result.lastInsertRowid);
}

/**
 * The first time `matches` sees a statement, run `inject` right after it (only
 * once), returning a getter for whatever `inject` started.
 */
function injectOnce<T>(
  hooks: DriverHook[],
  matches: (sql: string) => boolean,
  inject: () => Promise<T> | T,
): () => Promise<T> {
  let started: Promise<T> | undefined;
  hooks.push({
    matches: (sql) => started === undefined && matches(sql),
    after: () => {
      started = Promise.resolve(inject());
    },
  });
  return () => {
    if (!started) {
      throw new Error("the injection point was never reached");
    }
    return started;
  };
}

function postJson(app: Hono, path: string, body: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("T2 updateTask on the async DB port (#604)", () => {
  it("AC-6: when recording the task_update event fails, the task update is not kept either", async () => {
    const { db, raw, hooks } = await setup();
    const taskId = insertRawTask(raw, { status: "todo", title: "元のタイトル" });
    hooks.push({
      matches: (sql) => sql.trimStart().startsWith("INSERT INTO activity_events"),
      after: () => {
        throw new Error("injected event write failure");
      },
    });

    await expect(updateTask(db, taskId, { title: "新しいタイトル" })).rejects.toThrow(
      "injected event write failure",
    );

    const row = raw.prepare("SELECT title FROM tasks WHERE id = ?").get(taskId) as { title: string };
    expect(row.title).toBe("元のタイトル");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM activity_events").get()).toEqual({ n: 0 });
  });

  it("AC-18: a title-only update and a status-only update sent concurrently to the same task both survive", async () => {
    const { db, raw, hooks } = await setup();
    const taskId = insertRawTask(raw, { status: "todo", title: "元のタイトル" });
    const second = injectOnce(
      hooks,
      (sql) => sql === TASK_READ,
      () => updateTask(db, taskId, { status: "in_progress" }),
    );

    const first = await updateTask(db, taskId, { title: "新しいタイトル" });
    const secondResult = await second();

    expect(first.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    const row = raw.prepare("SELECT title, status FROM tasks WHERE id = ?").get(taskId);
    expect(row).toEqual({ title: "新しいタイトル", status: "in_progress" });
  });
});

describe("T3 checkins on the async DB port (#604)", () => {
  it("AC-8: two concurrent task_start checkins on the same todo task record only one in_progress transition", async () => {
    const { raw, hooks, app } = await setup();
    const taskId = insertRawTask(raw, { status: "todo" });
    const second = injectOnce(
      hooks,
      (sql) => sql === TASK_READ,
      () => postJson(app, "/api/checkins", { type: "task_start", task_id: taskId }),
    );

    const first = await postJson(app, "/api/checkins", { type: "task_start", task_id: taskId });
    const secondRes = await second();

    expect(first.status).toBe(201);
    expect(secondRes.status).toBe(201);
    const transitions = raw
      .prepare("SELECT COUNT(*) AS n FROM activity_events WHERE type = 'task_update' AND task_id = ?")
      .get(taskId);
    expect(transitions).toEqual({ n: 1 });
    expect(raw.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({
      status: "in_progress",
    });
  });

  it("AC-21: two concurrent break_end checkins with the same occurred_at on an open break record one break_end and reject the other with 400", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 5, 15, 0, 0));
    const { raw, hooks, app } = await setup();
    raw
      .prepare("INSERT INTO activity_events (type, created_at) VALUES ('break_start', ?)")
      .run(new Date(2026, 6, 5, 12, 0, 0).toISOString());
    const occurredAt = new Date(2026, 6, 5, 13, 0, 0).toISOString();
    const second = injectOnce(
      hooks,
      (sql) => sql.includes("type = 'break_start' AND created_at = ?"),
      () => postJson(app, "/api/checkins", { type: "break_end", occurred_at: occurredAt }),
    );

    const first = await postJson(app, "/api/checkins", { type: "break_end", occurred_at: occurredAt });
    const secondRes = await second();

    expect([first.status, secondRes.status].sort()).toEqual([201, 400]);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE type = 'break_end'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("E1 evidence delete vs T2 completion on the async DB port (#604)", () => {
  async function setupEvidenceRequiredTask(): Promise<Harness & { taskId: number; evidenceId: number }> {
    const harness = await setup();
    harness.raw
      .prepare("INSERT INTO settings (key, value) VALUES ('evidence_enforcement_enabled', 'true')")
      .run();
    const taskId = insertRawTask(harness.raw, { status: "in_progress", evidenceRequired: true });
    const evidence = harness.raw
      .prepare(
        "INSERT INTO task_evidences (task_id, kind, url, created_at) VALUES (?, 'link', 'https://example.com/a', ?)",
      )
      .run(taskId, new Date().toISOString());
    return { ...harness, taskId, evidenceId: Number(evidence.lastInsertRowid) };
  }

  function deleteEvidenceRequest(app: Hono, taskId: number, evidenceId: number) {
    return app.request(`/api/tasks/${taskId}/evidences/${evidenceId}`, { method: "DELETE" });
  }

  function completeRequest(app: Hono, taskId: number) {
    return postJson(app, `/api/tasks/${taskId}`, { status: "done" }, "PATCH");
  }

  function doneWithoutEvidence(raw: Database.Database, taskId: number): boolean {
    const task = raw.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    const count = raw
      .prepare("SELECT COUNT(*) AS n FROM task_evidences WHERE task_id = ?")
      .get(taskId) as { n: number };
    return task.status === "done" && count.n === 0;
  }

  it("AC-22 (delete first): the concurrent completion is rejected with evidence_required (409) and no done-without-evidence task remains", async () => {
    const { raw, hooks, app, taskId, evidenceId } = await setupEvidenceRequiredTask();
    const completion = injectOnce(
      hooks,
      (sql) => sql === TASK_READ,
      () => completeRequest(app, taskId),
    );

    const deletion = await deleteEvidenceRequest(app, taskId, evidenceId);
    const completionRes = await completion();

    expect(deletion.status).toBe(204);
    expect(completionRes.status).toBe(409);
    expect(await completionRes.json()).toMatchObject({ code: "evidence_required" });
    expect(doneWithoutEvidence(raw, taskId)).toBe(false);
  });

  it("AC-22 (completion first): the concurrent delete is rejected with task_already_done (409) and no done-without-evidence task remains", async () => {
    const { raw, hooks, app, taskId, evidenceId } = await setupEvidenceRequiredTask();
    const deletion = injectOnce(
      hooks,
      (sql) => sql.startsWith("SELECT COUNT(*) AS count FROM task_evidences"),
      () => deleteEvidenceRequest(app, taskId, evidenceId),
    );

    const completionRes = await completeRequest(app, taskId);
    const deletionRes = await deletion();

    expect(completionRes.status).toBe(200);
    expect(deletionRes.status).toBe(409);
    expect(await deletionRes.json()).toMatchObject({ code: "task_already_done" });
    expect(doneWithoutEvidence(raw, taskId)).toBe(false);
  });
});
