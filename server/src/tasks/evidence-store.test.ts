import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { insertTask } from "./tasks-repository.js";
import { findTaskEvidenceById } from "./task-evidences-repository.js";
import { deleteEvidence, saveFileEvidence, saveLinkEvidence, type EvidenceStore } from "./evidence-store.js";

/**
 * 実行環境に依存しないコアの証跡保存ロジック（機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」実装計画②）を、
 * Node `fs` を一切使わないインメモリ `EvidenceStore` で直接検証する。
 *
 * `evidence-storage.test.ts`（Node fs アダプタ経由）と対になる — こちらは
 * ポート自体の契約（`store.write`/`store.read`/`store.remove` の呼ばれ方と
 * DB 行との整合）を、実ファイルシステムに触れずに固定する。
 */
function createTask(db: Database.Database): number {
  const task = insertTask(db, {
    title: "テストタスク",
    description: null,
    category: "work",
    priority: null,
    due_at: null,
    status: "todo",
    boss_comment: null,
    estimated_minutes: null,
  });
  return task.id;
}

function createMemoryEvidenceStore(): EvidenceStore & { files: Map<string, Uint8Array<ArrayBuffer>> } {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    files,
    write(storedFilename, data) {
      files.set(storedFilename, data);
    },
    read(storedFilename) {
      return files.get(storedFilename);
    },
    remove(storedFilename) {
      files.delete(storedFilename);
    },
  };
}

describe("evidence-store (core)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("saveFileEvidence", () => {
    it("writes the bytes through the store and inserts a task_evidences row referencing the same stored_filename", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);
      const data = new Uint8Array([1, 2, 3]);

      const evidence = saveFileEvidence(db, store, {
        taskId,
        originalFilename: "note.txt",
        data,
      });

      expect(evidence.kind).toBe("file");
      expect(store.files.get(evidence.stored_filename as string)).toEqual(data);
    });

    it("generates a stored_filename different from the original filename", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, store, {
        taskId,
        originalFilename: "note.txt",
        data: new Uint8Array([1]),
      });

      expect(evidence.stored_filename).not.toBe("note.txt");
    });

    it("preserves the extension (lowercased) in the stored_filename", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);

      const evidence = saveFileEvidence(db, store, {
        taskId,
        originalFilename: "SCREENSHOT.PNG",
        data: new Uint8Array([1]),
      });

      expect(evidence.stored_filename).toMatch(/\.png$/);
    });

    it("throws without writing to the store when the extension is not allowed", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);

      expect(() =>
        saveFileEvidence(db, store, {
          taskId,
          originalFilename: "malware.exe",
          data: new Uint8Array([1]),
        }),
      ).toThrow();
      expect(store.files.size).toBe(0);
    });
  });

  describe("saveLinkEvidence", () => {
    it("inserts a link row without touching the store", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);

      const evidence = saveLinkEvidence(db, { taskId, url: "https://example.com/doc" });

      expect(evidence.kind).toBe("link");
      expect(evidence.url).toBe("https://example.com/doc");
      expect(store.files.size).toBe(0);
    });
  });

  describe("deleteEvidence", () => {
    it("removes both the DB row and the store entry for a file evidence", () => {
      const store = createMemoryEvidenceStore();
      const taskId = createTask(db);
      const evidence = saveFileEvidence(db, store, {
        taskId,
        originalFilename: "note.txt",
        data: new Uint8Array([1]),
      });

      const deleted = deleteEvidence(db, store, evidence.id);

      expect(deleted).toBe(true);
      expect(findTaskEvidenceById(db, evidence.id)).toBeUndefined();
      expect(store.files.has(evidence.stored_filename as string)).toBe(false);
    });

    it("returns false and does not throw for a non-existent evidence id", () => {
      const store = createMemoryEvidenceStore();

      expect(deleteEvidence(db, store, 9999)).toBe(false);
    });

    it("does not call store.remove for a link evidence (no file to remove)", () => {
      // self-review（code-reviewer, CONFIRMED）: 以前は deleted===true と DB
      // 行の消失だけを見ており、`remove` が実際に呼ばれたかどうかを一切
      // 検証していなかった（`Map#delete` は存在しないキーに対して no-op な
      // ので、呼ばれても呼ばれなくても観測できなかった）。`vi.fn` で
      // `remove` を包み、呼ばれていないことを直接アサートする — この契約
      // には `tasks/task-evidences-routes.ts` の DELETE ハンドラが依存する
      // （evidenceStore 未設定でも link の削除は許可し、file の削除だけ
      // 500 にするため、`remove` を呼ぶと throw する
      // `UNAVAILABLE_EVIDENCE_STORE` を渡している）。
      const store = createMemoryEvidenceStore();
      const removeSpy = vi.spyOn(store, "remove");
      const taskId = createTask(db);
      const evidence = saveLinkEvidence(db, { taskId, url: "https://example.com" });

      const deleted = deleteEvidence(db, store, evidence.id);

      expect(deleted).toBe(true);
      expect(findTaskEvidenceById(db, evidence.id)).toBeUndefined();
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });
});
