import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { createCoreApp } from "./core-app.js";

/**
 * `createCoreApp`（実行環境に依存しないコア。機能仕様
 * docs/features/tauri-in-app-runtime.md「機能全体の設計」）の直接単体テスト。
 * `app.test.ts`（開発者用の版の合成ルート `createApp` 経由）・
 * `core-entry.bundle.test.ts`（esbuild で束ねた上での vm 評価）と役割が違う
 * — こちらは Node の通常のモジュールグラフの上で、素の `createCoreApp` の
 * 引数契約（`env` が必須・`evidenceStore` は任意）だけを最短で確認する。
 */
describe("createCoreApp", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns 200 with status ok and db true from GET /api/health", async () => {
    const app = createCoreApp(db, {});

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: true });
  });

  it("returns 404 for an unknown path", async () => {
    const app = createCoreApp(db, {});

    const res = await app.request("/api/unknown");

    expect(res.status).toBe(404);
  });

  it("does not serve any static frontend (that is app.ts's job, not the core's)", async () => {
    const app = createCoreApp(db, {});

    const res = await app.request("/");

    expect(res.status).toBe(404);
  });

  it("answers the evidence upload route with 500 (not an unhandled exception) when evidenceStore is omitted", async () => {
    const app = createCoreApp(db, {});

    const createTaskRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "テスト" }),
    });
    const task = (await createTaskRes.json()) as { id: number };

    const formData = new FormData();
    formData.set("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));

    const res = await app.request(`/api/tasks/${task.id}/evidences`, {
      method: "POST",
      body: formData,
    });

    expect(res.status).toBe(500);
  });

  // self-review（code-reviewer, CONFIRMED）: `task-evidences-routes.ts` が
  // `evidenceDir` から `EvidenceStore` ポートへ変わった際に生まれた新しい
  // 分岐（実体欠損時の 404・`evidenceStore` 未設定時の 500・
  // `evidenceStore` 未設定でも link の削除だけは許可する経路）は、
  // `tasks/task-evidences-routes.test.ts`（AC13: 変更なしで合格させる既存
  // テスト。evidenceDir を常に設定するテストのみ）ではカバーされない。
  // 保護対象のそのファイルを変えずに、ここへ新規カバレッジを足す。
  describe("evidence routes — EvidenceStore-dependent branches (post-refactor, not covered by the protected task-evidences-routes.test.ts)", () => {
    function createMemoryEvidenceStore() {
      const files = new Map<string, Uint8Array<ArrayBuffer>>();
      return {
        write(storedFilename: string, data: Uint8Array<ArrayBuffer>) {
          files.set(storedFilename, data);
        },
        read(storedFilename: string) {
          return files.get(storedFilename);
        },
        remove(storedFilename: string) {
          files.delete(storedFilename);
        },
      };
    }

    async function createTask(app: ReturnType<typeof createCoreApp>): Promise<number> {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "テスト" }),
      });
      const task = (await res.json()) as { id: number };
      return task.id;
    }

    it("returns 404 (not the readFileSync-era 500) for GET content when the stored file is missing from the store", async () => {
      const evidenceStore = createMemoryEvidenceStore();
      const app = createCoreApp(db, {}, { evidenceStore });
      const taskId = await createTask(app);

      const formData = new FormData();
      formData.set("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const uploadRes = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: formData,
      });
      const evidence = (await uploadRes.json()) as { id: number; stored_filename: string };

      // 実体をストアから直接消し、DB 行だけが残った（実体欠損の）状態を作る。
      evidenceStore.remove(evidence.stored_filename);

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}/content`);
      expect(res.status).toBe(404);
    });

    it("returns 500 for GET content when evidenceStore is not configured", async () => {
      const evidenceStore = createMemoryEvidenceStore();
      const appWithStore = createCoreApp(db, {}, { evidenceStore });
      const taskId = await createTask(appWithStore);
      const formData = new FormData();
      formData.set("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const uploadRes = await appWithStore.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: formData,
      });
      const evidence = (await uploadRes.json()) as { id: number };

      // 同じ DB を、evidenceStore を渡さない別の app インスタンスから読む。
      const appWithoutStore = createCoreApp(db, {});
      const res = await appWithoutStore.request(`/api/tasks/${taskId}/evidences/${evidence.id}/content`);
      expect(res.status).toBe(500);
    });

    it("returns 500 for DELETE of a file evidence when evidenceStore is not configured", async () => {
      const evidenceStore = createMemoryEvidenceStore();
      const appWithStore = createCoreApp(db, {}, { evidenceStore });
      const taskId = await createTask(appWithStore);
      const formData = new FormData();
      formData.set("file", new File([new Uint8Array([1])], "note.txt", { type: "text/plain" }));
      const uploadRes = await appWithStore.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        body: formData,
      });
      const evidence = (await uploadRes.json()) as { id: number };

      const appWithoutStore = createCoreApp(db, {});
      const res = await appWithoutStore.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(500);
    });

    it("returns 204 for DELETE of a link evidence even when evidenceStore is not configured (no file to remove)", async () => {
      const app = createCoreApp(db, {});
      const taskId = await createTask(app);

      const linkRes = await app.request(`/api/tasks/${taskId}/evidences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/doc" }),
      });
      const evidence = (await linkRes.json()) as { id: number };

      const res = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });
  });
});
