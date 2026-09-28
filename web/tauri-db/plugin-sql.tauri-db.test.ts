// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { describeDbPortContract } from "../../server/src/db/test-support/db-port-contract.js";
import { createSerializedDb } from "../../server/src/core-entry.js";
import { createPluginSqlDriver } from "../src/app-entry/plugin-sql-driver";
import { getProductDatabase, openProductDb } from "../src/app-entry/product-db";
import { createProductCoreApp } from "../src/app-entry/create-product-core-app";
import { startSqlIpcBridge, type SqlIpcBridge } from "./sql-ipc-bridge";

/**
 * 製品版（plugin-sql 実装）で、両版で同じ契約スイートと製品版のエントリを
 * 回す（#580 S2・機能仕様 docs/features/async-db-layer.md「契約テストを器の
 * 上で通す仕組み」・受入基準（S2）AC-S2-9・AC-S2-13〜23）。
 *
 * 経路: 製品版のドライバ → `@tauri-apps/plugin-sql`（JS。上流のまま）→
 * `mockIPC` → 器の IPC の中継（子プロセス。器と同じ `tauri.conf.json`・
 * capability の ACL・リポジトリ内 fork の plugin-sql）。置き換わるのは
 * WebView と Rust の間の転送だけ。`npm run test:tauri-db` で回す（`npm test`
 * には含めない — 中継のビルドに cargo が要るため）。
 */

interface BridgeConnection {
  bridge: SqlIpcBridge;
  /** 中継へ流れた IPC の要求 */
  commands: { cmd: string; args: unknown }[];
  close(): Promise<void>;
}

async function connectToBridge(): Promise<BridgeConnection> {
  const bridge = await startSqlIpcBridge();
  const commands: BridgeConnection["commands"] = [];
  // `mockIPC` は `window.__TAURI_INTERNALS__` に差し込む。node の環境では
  // `window` が無いので、グローバルを `window` として見せる。
  vi.stubGlobal("window", globalThis);
  mockIPC((cmd, args) => {
    commands.push({ cmd, args });
    return bridge.invoke(cmd, args);
  });
  return {
    bridge,
    commands,
    async close() {
      clearMocks();
      vi.unstubAllGlobals();
      await bridge.close();
    },
  };
}

describeDbPortContract("plugin-sql（器の IPC の中継・リポジトリ内 fork）", async () => {
  const connection = await connectToBridge();
  return {
    db: createSerializedDb(createPluginSqlDriver(getProductDatabase())),
    close: () => connection.close(),
  };
});

describe("製品版のエントリ（plugin-sql 実装・器の IPC の中継）", () => {
  let connection: BridgeConnection;

  beforeEach(async () => {
    connection = await connectToBridge();
  });

  afterEach(async () => {
    await connection.close();
  });

  it('AC-S2-22: /api/health はステータス 200・{"status":"ok","db":true} を返す', async () => {
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));

    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", db: true });
  });

  it("AC-S2-23: POST /api/tasks で作ったタスクが GET /api/tasks で返る", async () => {
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));

    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "牛乳を買う" }),
    });
    expect(created.status).toBe(201);
    const listed = await app.request("/api/tasks");

    expect(listed.status).toBe(200);
    const tasks = (await listed.json()) as { title: string }[];
    expect(tasks.map((task) => task.title)).toEqual(["牛乳を買う"]);
  });

  it("前のページが残したトランザクションは、DB の準備で閉じられ、以後の書き込みはコミットされる（仮定 A11）", async () => {
    // 前のページが BEGIN IMMEDIATE の途中で読み込み直された状態を作る。
    await connection.bridge.invoke("plugin:sql|execute", {
      db: "sqlite:ai-boss.db",
      query: "BEGIN IMMEDIATE",
      values: [],
    });
    const app = createProductCoreApp(await openProductDb(getProductDatabase()));
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "残る" }),
    });
    expect(created.status).toBe(201);

    // 開いたトランザクションが残っていれば、この ROLLBACK がタスクを消す。
    await connection.bridge
      .invoke("plugin:sql|execute", { db: "sqlite:ai-boss.db", query: "ROLLBACK", values: [] })
      .catch(() => undefined);

    const tasks = (await (await app.request("/api/tasks")).json()) as { title: string }[];
    expect(tasks.map((task) => task.title)).toEqual(["残る"]);
  });

  it("AC-S2-9: 製品版の DB の準備で中継へ流れるのは sqlite:ai-boss.db 宛ての execute/select だけで、load を呼ばない", async () => {
    await openProductDb(getProductDatabase());

    expect(connection.commands.length).toBeGreaterThan(0);
    for (const { cmd, args } of connection.commands) {
      expect(["plugin:sql|execute", "plugin:sql|select"]).toContain(cmd);
      expect(args).toMatchObject({ db: "sqlite:ai-boss.db" });
    }
    // DB ファイルは Rust 側の preload がアプリのデータディレクトリに作る。
    expect(
      existsSync(join(connection.bridge.home, "Library/Application Support/dev.aiboss.app/ai-boss.db")),
    ).toBe(true);
  });
});
