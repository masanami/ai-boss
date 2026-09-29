// @vitest-environment node
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEvidenceStoreContract, newStoredFilename } from "../../server/src/tasks/test-support/evidence-store-contract.js";
import { createPluginFsEvidenceStore } from "../src/app-entry/plugin-fs-evidence-store";
import { getProductDatabase, openProductDb } from "../src/app-entry/product-db";
import { createProductCoreApp } from "../src/app-entry/create-product-core-app";
import { installBridgeInternals, startSqlIpcBridge, type SqlIpcBridge } from "./sql-ipc-bridge";

/**
 * 製品版（plugin-fs 実装）で、両版で同じ契約スイートと製品版のエントリを回す
 * （#579 S4・機能仕様 docs/features/tauri-in-app-runtime.md「契約テストを器の上で
 * 通す仕組み」・受入基準（S4）AC-S4-25〜31）。
 *
 * 経路: 製品版の実装 → `@tauri-apps/plugin-fs`（JS。上流のまま）→
 * `__TAURI_INTERNALS__.invoke` → 器の IPC の中継（子プロセス。器と同じ
 * `tauri.conf.json`・capability の ACL・上流の plugin-fs）。置き換わるのは
 * WebView と Rust の間の転送だけ。`npm run test:tauri-db` で回す（`npm test` には
 * 含めない — 中継のビルドに cargo が要るため）。
 */

interface BridgeConnection {
  bridge: SqlIpcBridge;
  commands: { cmd: string; args: unknown }[];
  /** 中継の `HOME` の下の、製品版の保存先（`app_config_dir/evidence`） */
  evidenceDir: string;
  close(): Promise<void>;
}

async function connectToBridge(): Promise<BridgeConnection> {
  const bridge = await startSqlIpcBridge();
  const installed = installBridgeInternals(bridge, (name, value) => vi.stubGlobal(name, value));
  return {
    bridge,
    commands: installed.commands,
    evidenceDir: join(bridge.home, "Library", "Application Support", "dev.aiboss.app", "evidence"),
    async close() {
      installed.uninstall();
      vi.unstubAllGlobals();
      await bridge.close();
    },
  };
}

describeEvidenceStoreContract("plugin-fs（器の IPC の中継・上流の plugin-fs）", async () => {
  const connection = await connectToBridge();
  return {
    store: createPluginFsEvidenceStore(),
    close: () => connection.close(),
  };
});

describe("製品版の証跡の保存（plugin-fs 実装・器の IPC の中継）", () => {
  let connection: BridgeConnection;

  beforeEach(async () => {
    connection = await connectToBridge();
  });

  afterEach(async () => {
    await connection.close();
  });

  it("AC-S4-25: write すると、中継の HOME の Library/Application Support/dev.aiboss.app/evidence/<保存名> に書いたバイト列のファイルができる", async () => {
    const storedFilename = newStoredFilename(".png");
    const data = new Uint8Array([0, 255, 1, 254, 128, 127]);

    await createPluginFsEvidenceStore().write(storedFilename, data);

    expect(readdirSync(connection.evidenceDir)).toEqual([storedFilename]);
    expect(new Uint8Array(readFileSync(join(connection.evidenceDir, storedFilename)))).toEqual(data);
  });

  it("形の検査に通らない保存名は中継へ何も送らず、保存先にも何もできない（多層防御の 1 層目）", async () => {
    const store = createPluginFsEvidenceStore();

    await expect(Promise.resolve().then(() => store.write("../ai-boss.db", new Uint8Array([1])))).rejects.toThrow();
    expect(await store.read("../ai-boss.db")).toBeUndefined();
    await store.remove("../ai-boss.db");

    expect(connection.commands).toEqual([]);
    expect(readdirSync(connection.evidenceDir)).toEqual([]);
  });

  it("形の検査を通った保存名での IPC の失敗（保存先が無い）は握りつぶさず伝える (A12)", async () => {
    rmSync(connection.evidenceDir, { recursive: true });

    await expect(
      Promise.resolve().then(() => createPluginFsEvidenceStore().write(newStoredFilename(), new Uint8Array([1]))),
    ).rejects.toBeDefined();
  });
});

describe("製品版のエントリ（plugin-sql ＋ plugin-fs 実装・器の IPC の中継）", () => {
  let connection: BridgeConnection;

  beforeEach(async () => {
    connection = await connectToBridge();
  });

  afterEach(async () => {
    await connection.close();
  });

  async function createTask(app: ReturnType<typeof createProductCoreApp>): Promise<number> {
    const response = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "証跡のテスト" }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: number }).id;
  }

  async function upload(app: ReturnType<typeof createProductCoreApp>, taskId: number, name: string, bytes: Uint8Array<ArrayBuffer>) {
    const formData = new FormData();
    formData.set("file", new File([bytes], name));
    const response = await app.request(`/api/tasks/${taskId}/evidences`, { method: "POST", body: formData });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: number; stored_filename: string; size_bytes: number };
  }

  it("AC-S4-30: ファイル証跡をアップロードすると、本文（GET …/content）は送ったバイト列と同じである", async () => {
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));
    const taskId = await createTask(app);
    const bytes = Uint8Array.from({ length: 2048 }, (_, i) => (i * 7) % 256);

    const evidence = await upload(app, taskId, "shot.png", bytes);
    const content = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}/content`);

    expect(content.status).toBe(200);
    expect(content.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    // 実体は製品版の保存先に、DB の保存名で置かれる。
    expect(readdirSync(connection.evidenceDir)).toEqual([evidence.stored_filename]);
  });

  it("AC-S4-31: ファイル証跡を削除すると、実体のファイルは保存先から消える", async () => {
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));
    const taskId = await createTask(app);
    const evidence = await upload(app, taskId, "note.txt", new Uint8Array([1, 2, 3]));
    const file = join(connection.evidenceDir, evidence.stored_filename);
    expect(existsSync(file)).toBe(true);

    const response = await app.request(`/api/tasks/${taskId}/evidences/${evidence.id}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(connection.evidenceDir)).toEqual([]);
  });

  it("DB に入った任意の保存名（../ai-boss.db）を本文の取得に使わせても、DB ファイルを返さず 404 になる", async () => {
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));
    const taskId = await createTask(app);
    const db = getProductDatabase();
    // WebView の JS は SQL を実行できるため、保存名は任意の文字列になりうる。
    await db.execute(
      "INSERT INTO task_evidences (task_id, kind, stored_filename, original_filename, mime_type, size_bytes, created_at) VALUES (?, 'file', ?, 'evil.png', 'image/png', 1, ?)",
      [taskId, "../ai-boss.db", "2026-09-29T00:00:00.000Z"],
    );
    const row = (await db.select<{ id: number }[]>("SELECT id FROM task_evidences WHERE stored_filename = ?", ["../ai-boss.db"]))[0];

    const content = await app.request(`/api/tasks/${taskId}/evidences/${row?.id}/content`);

    expect(content.status).toBe(404);
  });
});
