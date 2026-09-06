import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { setSettingValue } from "../settings/settings-repository.js";
import { insertTaskEvidence } from "./task-evidences-repository.js";
import {
  insertTask,
  isEvidenceGateBlocking,
  updateTask,
  type NewTaskRecord,
} from "./tasks-repository.js";
import type { ActivityEvent } from "../activity/activity-event.js";
import type { Task } from "./task.js";

/**
 * 機能仕様 docs/features/completion-evidence-enforcement.md 決定 2・
 * Issue #389 の完了条件（AC-12〜AC-38, AC-79〜AC-81）のうち、リポジトリ層
 * （`isEvidenceGateBlocking` / `updateTask` / `insertTask`）で直接検証できる
 * ものをここでテストする。HTTP 経路・ボスチャット経路の応答形（409・code・
 * エラー文言）は `tasks-routes.test.ts` / `task-tools.test.ts` の担当。
 */

function insertWorkTask(
  db: Database.Database,
  overrides: Partial<NewTaskRecord> = {},
): Task {
  return insertTask(db, {
    title: "資料作成",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
    evidence_required: false,
    ...overrides,
  });
}

function enableEnforcement(db: Database.Database): void {
  setSettingValue(db, "evidence_enforcement_enabled", "true");
}

function listTaskUpdateEvents(db: Database.Database): ActivityEvent[] {
  return db
    .prepare("SELECT * FROM activity_events WHERE type = 'task_update'")
    .all() as ActivityEvent[];
}

describe("isEvidenceGateBlocking", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns false when evidenceRequired is false, even with enforcement on and no evidence", () => {
    enableEnforcement(db);
    const task = insertWorkTask(db, { evidence_required: false });

    expect(
      isEvidenceGateBlocking(db, { taskId: task.id, evidenceRequired: false }),
    ).toBe(false);
  });

  it("returns false when the enforcement setting is off, even when evidenceRequired is true and there is no evidence", () => {
    const task = insertWorkTask(db, { evidence_required: true });

    expect(
      isEvidenceGateBlocking(db, { taskId: task.id, evidenceRequired: true }),
    ).toBe(false);
  });

  it("returns true when enforcement is on, evidenceRequired is true, and the task has zero evidence", () => {
    enableEnforcement(db);
    const task = insertWorkTask(db, { evidence_required: true });

    expect(
      isEvidenceGateBlocking(db, { taskId: task.id, evidenceRequired: true }),
    ).toBe(true);
  });

  // AC-30 の境界: 1件あれば通す（0 → 1 の境界。変異確認4で検証）。
  it("returns false when enforcement is on, evidenceRequired is true, and the task has at least one evidence", () => {
    enableEnforcement(db);
    const task = insertWorkTask(db, { evidence_required: true });
    insertTaskEvidence(db, { task_id: task.id, kind: "link", url: "https://example.com" });

    expect(
      isEvidenceGateBlocking(db, { taskId: task.id, evidenceRequired: true }),
    ).toBe(false);
  });

  // 決定 2-h: taskId: null は「作成中でまだ存在しないタスク」を表し、
  // エビデンス件数は常に0として扱う。
  it("taskId: null (create path) blocks when enforcement is on and evidenceRequired is true", () => {
    enableEnforcement(db);

    expect(
      isEvidenceGateBlocking(db, { taskId: null, evidenceRequired: true }),
    ).toBe(true);
  });

  it("taskId: null (create path) does not block when evidenceRequired is false", () => {
    enableEnforcement(db);

    expect(
      isEvidenceGateBlocking(db, { taskId: null, evidenceRequired: false }),
    ).toBe(false);
  });
});

describe("updateTask", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns { ok: false, reason: 'not_found' } for a non-existent id", () => {
    const result = updateTask(db, 9999, { title: "更新" });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns { ok: true, task } with the applied patch on success", () => {
    const task = insertWorkTask(db);

    const result = updateTask(db, task.id, { priority: "high" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toMatchObject({ id: task.id, priority: "high" });
    }
  });

  describe("completion-evidence gate (決定2)", () => {
    // AC-23〜AC-27
    it("rejects a transition to done with reason 'evidence_required' when enforcement is on, evidence_required is true, and there is no evidence (AC-23)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      const result = updateTask(db, task.id, { status: "done" });

      expect(result).toEqual({ ok: false, reason: "evidence_required" });
    });

    it("writes nothing to the task row on rejection (status/updated_at/completed_at all unchanged, AC-25/AC-26)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      updateTask(db, task.id, { status: "done" });

      const after = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as {
        status: string;
        updated_at: string;
        completed_at: string | null;
      };
      expect(after.status).toBe("todo");
      expect(after.completed_at).toBeNull();
      expect(after.updated_at).toBe(task.updated_at);
    });

    it("records no task_update activity event on rejection (AC-27)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      updateTask(db, task.id, { status: "done" });

      expect(listTaskUpdateEvents(db)).toHaveLength(0);
    });

    it("allows the done transition when the enforcement setting is off (AC-28)", () => {
      const task = insertWorkTask(db, { evidence_required: true });

      const result = updateTask(db, task.id, { status: "done" });

      expect(result.ok).toBe(true);
    });

    it("allows the done transition when evidence_required is false, even with zero evidence (AC-29)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: false });

      const result = updateTask(db, task.id, { status: "done" });

      expect(result.ok).toBe(true);
    });

    it("allows the done transition when there is at least one evidence (AC-30)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });
      insertTaskEvidence(db, { task_id: task.id, kind: "link", url: "https://example.com" });

      const result = updateTask(db, task.id, { status: "done" });

      expect(result.ok).toBe(true);
    });

    it("allows transitioning to dropped even with zero evidence (AC-31 — the gate only applies to done)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      const result = updateTask(db, task.id, { status: "dropped" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.status).toBe("dropped");
      }
    });

    // 決定 2-a: 判定条件は「done への遷移」であって「done であること」ではない
    it("does not retroactively block a patch on an already-done task, even with zero evidence (AC-35)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true, status: "done" });

      const result = updateTask(db, task.id, { title: "更新後のタイトル" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.title).toBe("更新後のタイトル");
        expect(result.task.status).toBe("done");
      }
    });

    // 決定 2-c: 関門はパッチ適用後の値を見る
    it("allows { evidence_required: false, status: 'done' } in one patch, even with zero evidence (AC-36)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      const result = updateTask(db, task.id, {
        evidence_required: false,
        status: "done",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.status).toBe("done");
        expect(result.task.evidence_required).toBe(false);
      }
    });

    it("records a task_update event whose note reflects the evidence_required change for the combined patch above (AC-37)", () => {
      enableEnforcement(db);
      const task = insertWorkTask(db, { evidence_required: true });

      updateTask(db, task.id, { evidence_required: false, status: "done" });

      const events = listTaskUpdateEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].note).not.toBeNull();
      expect(events[0].note).toContain("必須");
      expect(events[0].note).toContain("不要");
    });
  });

  describe("evidence_required の変更を活動ログの note に残す（決定3-b）", () => {
    it("records a note describing the change when evidence_required changes (AC-19)", () => {
      const task = insertWorkTask(db, { evidence_required: true });

      updateTask(db, task.id, { evidence_required: false });

      const events = listTaskUpdateEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].note).not.toBeNull();
    });

    it("leaves note null when the patch does not include evidence_required (AC-20)", () => {
      const task = insertWorkTask(db, { evidence_required: false });

      updateTask(db, task.id, { title: "タイトルだけ変更" });

      const events = listTaskUpdateEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].note).toBeNull();
    });
  });

  describe("evidence_required の変換（HTTP境界 boolean / DB INTEGER、明示的な仮定8）", () => {
    it("persists evidence_required as boolean true after insertTask(true)", () => {
      const task = insertWorkTask(db, { evidence_required: true });
      expect(task.evidence_required).toBe(true);

      const raw = db
        .prepare("SELECT evidence_required FROM tasks WHERE id = ?")
        .get(task.id) as { evidence_required: number };
      expect(raw.evidence_required).toBe(1);
    });

    it("PATCH evidence_required: true from false persists and reads back as boolean (AC-17)", () => {
      const task = insertWorkTask(db, { evidence_required: false });

      const result = updateTask(db, task.id, { evidence_required: true });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.evidence_required).toBe(true);
      }
      const raw = db
        .prepare("SELECT evidence_required FROM tasks WHERE id = ?")
        .get(task.id) as { evidence_required: number };
      expect(raw.evidence_required).toBe(1);
    });
  });
});

describe("insertTask evidence_required (AC-12/AC-13)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("defaults evidence_required to false when omitted", () => {
    const task = insertWorkTask(db);
    expect(task.evidence_required).toBe(false);
  });

  it("persists evidence_required: true", () => {
    const task = insertWorkTask(db, { evidence_required: true });
    expect(task.evidence_required).toBe(true);
  });
});
