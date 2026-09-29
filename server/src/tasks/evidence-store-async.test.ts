import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { portFor } from "../db/test-support/port-for.js";
import { createCoreApp } from "../core-app.js";
import { insertTask } from "./tasks-repository.js";
import { findTaskEvidenceById, insertTaskEvidence } from "./task-evidences-repository.js";
import { isValidStoredEvidenceFilename } from "./evidence-validation.js";
import {
  deleteEvidence,
  saveFileEvidence,
  saveFileEvidenceIfAllowed,
  type EvidenceStore,
} from "./evidence-store.js";

/**
 * 証跡の保存ポート（`EvidenceStore`）の戻り値に `Promise` を許す（#579 S4・
 * 機能仕様 docs/features/tauri-in-app-runtime.md 仮定 A10）。plugin-fs は IPC
 * 越しで非同期のため、コアはポートを呼ぶすべての箇所で戻り値を `await` する。
 *
 * 各操作の効果を**次のマクロタスクまで遅らせる**ストアを使う: `await` の
 * 抜けた呼び出し元は、効果が現れる前に先へ進むため、これらのテストは落ちる。
 * 既存の同期ストアのテスト（`evidence-store.test.ts` 等）は変更しない。
 */

const DELAY_MS = 5;

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

interface DelayedEvidenceStore extends EvidenceStore {
  files: Map<string, Uint8Array<ArrayBuffer>>;
  /** true にすると、次の書き込みは遅れてから失敗する */
  failNextWrite: boolean;
  /** true にすると、次の削除は遅れてから失敗する */
  failNextRemove: boolean;
}

function createDelayedEvidenceStore(): DelayedEvidenceStore {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const store: DelayedEvidenceStore = {
    files,
    failNextWrite: false,
    failNextRemove: false,
    async write(storedFilename, data) {
      await delay();
      if (store.failNextWrite) {
        store.failNextWrite = false;
        throw new Error("write failed");
      }
      files.set(storedFilename, data);
    },
    async read(storedFilename) {
      await delay();
      return files.get(storedFilename);
    },
    async remove(storedFilename) {
      await delay();
      if (store.failNextRemove) {
        store.failNextRemove = false;
        throw new Error("remove failed");
      }
      files.delete(storedFilename);
    },
  };
  return store;
}

async function createTask(db: Database.Database): Promise<number> {
  const task = await insertTask(portFor(db), {
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

describe("EvidenceStore が Promise を返す実装でも、コアは効果の完了を待つ (#579 S4 / A10)", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    await runMigrations(portFor(db));
  });

  afterEach(() => {
    db.close();
  });

  describe("saveFileEvidence", () => {
    it("resolves only after the store has written the bytes", async () => {
      const store = createDelayedEvidenceStore();
      const taskId = await createTask(db);

      const evidence = await saveFileEvidence(portFor(db), store, {
        taskId,
        originalFilename: "note.txt",
        data: new Uint8Array([1, 2, 3]),
      });

      expect(store.files.get(evidence.stored_filename as string)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("stores under a name that passes the stored-filename check (the generator and the validator agree)", async () => {
      const store = createDelayedEvidenceStore();
      const taskId = await createTask(db);

      const evidence = await saveFileEvidence(portFor(db), store, {
        taskId,
        originalFilename: "SCREENSHOT.PNG",
        data: new Uint8Array([1]),
      });

      expect(isValidStoredEvidenceFilename(evidence.stored_filename as string)).toBe(true);
    });

    it("rejects and inserts no row when the asynchronous write fails", async () => {
      const store = createDelayedEvidenceStore();
      store.failNextWrite = true;
      const taskId = await createTask(db);

      await expect(
        saveFileEvidence(portFor(db), store, {
          taskId,
          originalFilename: "note.txt",
          data: new Uint8Array([1]),
        }),
      ).rejects.toThrow("write failed");

      const rows = db.prepare("SELECT count(*) AS n FROM task_evidences").get() as { n: number };
      expect(rows.n).toBe(0);
    });
  });

  describe("saveFileEvidenceIfAllowed", () => {
    it("removes the written bytes before resolving when the insert guard refuses", async () => {
      const store = createDelayedEvidenceStore();
      const taskId = await createTask(db);

      const evidence = await saveFileEvidenceIfAllowed(
        portFor(db),
        store,
        { taskId, originalFilename: "note.txt", data: new Uint8Array([1]) },
        async () => false,
      );

      expect(evidence).toBeUndefined();
      expect(store.files.size).toBe(0);
    });
  });

  describe("deleteEvidence", () => {
    it("resolves only after the store has removed the bytes", async () => {
      const store = createDelayedEvidenceStore();
      const taskId = await createTask(db);
      const evidence = await saveFileEvidence(portFor(db), store, {
        taskId,
        originalFilename: "note.txt",
        data: new Uint8Array([1]),
      });

      expect(await deleteEvidence(portFor(db), store, evidence.id)).toBe(true);

      expect(store.files.size).toBe(0);
      expect(await findTaskEvidenceById(portFor(db), evidence.id)).toBeUndefined();
    });

    it("rejects when the asynchronous remove fails (the failure is not swallowed)", async () => {
      const store = createDelayedEvidenceStore();
      const taskId = await createTask(db);
      const evidence = await saveFileEvidence(portFor(db), store, {
        taskId,
        originalFilename: "note.txt",
        data: new Uint8Array([1]),
      });
      store.failNextRemove = true;

      await expect(deleteEvidence(portFor(db), store, evidence.id)).rejects.toThrow("remove failed");
    });
  });

  describe("routes (createCoreApp)", () => {
    async function upload(app: ReturnType<typeof createCoreApp>, taskId: number, bytes: number[]) {
      const formData = new FormData();
      formData.set("file", new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }));
      const res = await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: formData });
      // 失敗した POST の応答を行として使うと `evidence.id` が undefined になり、後続の
      // GET・DELETE がどの行にも届かないまま 404 などで通ってしまう。
      expect(res.status).toBe(201);
      return { res, evidence: (await res.json()) as { id: number; stored_filename: string } };
    }

    it("POST stores the bytes and GET .../content returns them from an asynchronous read", async () => {
      const store = createDelayedEvidenceStore();
      const app = createCoreApp(portFor(db), {}, { evidenceStore: store });
      const taskId = await createTask(db);

      const { res, evidence } = await upload(app, taskId, [9, 8, 7]);
      expect(res.status).toBe(201);

      const content = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    });

    it("GET .../content answers 404 when the asynchronous read finds nothing", async () => {
      const store = createDelayedEvidenceStore();
      const app = createCoreApp(portFor(db), {}, { evidenceStore: store });
      const taskId = await createTask(db);
      const { evidence } = await upload(app, taskId, [1]);
      store.files.clear();

      const content = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}/content`);

      expect(content.status).toBe(404);
    });

    it("DELETE answers 204 only after the store has removed the bytes", async () => {
      const store = createDelayedEvidenceStore();
      const app = createCoreApp(portFor(db), {}, { evidenceStore: store });
      const taskId = await createTask(db);
      const { evidence } = await upload(app, taskId, [1]);
      expect(store.files.size).toBe(1);

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, { method: "DELETE" });

      expect(res.status).toBe(204);
      expect(store.files.size).toBe(0);
    });

    it("DELETE of a link evidence does not touch the store", async () => {
      const store = createDelayedEvidenceStore();
      store.failNextRemove = true;
      const app = createCoreApp(portFor(db), {}, { evidenceStore: store });
      const taskId = await createTask(db);
      const link = await insertTaskEvidence(portFor(db), {
        task_id: taskId,
        kind: "link",
        url: "https://example.com",
      });

      const res = await app.request(`/api/tasks/${taskId}/evidences/${link.id}`, { method: "DELETE" });

      // 呼ばれていれば `failNextRemove` で失敗する（呼ばれると 500 になる）。
      expect(res.status).toBe(204);
      expect(store.failNextRemove).toBe(true);
    });
  });
});
