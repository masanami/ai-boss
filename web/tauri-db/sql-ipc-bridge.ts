import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * 器の IPC の中継（`native/tauri-app/examples/sql-ipc-bridge.rs`）を子プロセスで
 * 起動し、IPC の要求を送る（#580 S2・機能仕様 docs/features/async-db-layer.md
 * 「契約テストを器の上で通す仕組み」）。テスト専用。
 *
 * 中継は起動のたびに新しい一時ディレクトリを `HOME` にして器を組むため、
 * 起動ごとに空の DB（アプリのデータディレクトリの `ai-boss.db`）で始まり、
 * 利用者のアプリのデータディレクトリには触れない。中継のバイナリは
 * `npm run test:tauri-db` の前処理（`pretest:tauri-db`）がビルドする。
 */

const BRIDGE_BINARY = fileURLToPath(
  new URL("../../native/tauri-app/target/debug/examples/sql-ipc-bridge", import.meta.url),
);

export interface SqlIpcBridge {
  /** IPC の要求を送り、戻り値（エラーなら拒否）を返す */
  invoke(cmd: string, args: unknown): Promise<unknown>;
  /** 中継の `HOME`（一時ディレクトリ） */
  home: string;
  /** 中継を終わらせ、一時ディレクトリを消す */
  close(): Promise<void>;
}

type BridgeMessage = { ready: true } | { id: number; ok: unknown } | { id: number; err: unknown };

export async function startSqlIpcBridge(): Promise<SqlIpcBridge> {
  if (!existsSync(BRIDGE_BINARY)) {
    throw new Error(
      `the IPC bridge binary is missing: ${BRIDGE_BINARY} — run \`npm run test:tauri-db\` from the repository root (its pretest step builds the bridge)`,
    );
  }
  const home = mkdtempSync(join(tmpdir(), "ai-boss-sql-ipc-bridge-"));
  const child = spawn(BRIDGE_BINARY, [], {
    env: { ...process.env, AI_BOSS_SQL_BRIDGE_HOME: home },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  let nextId = 1;

  await new Promise<void>((resolveReady, rejectReady) => {
    child.once("error", rejectReady);
    void exited.then((code) => {
      const error = new Error(`the IPC bridge exited (code ${code})`);
      rejectReady(error);
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as BridgeMessage;
      if ("ready" in message) {
        resolveReady();
        return;
      }
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if ("ok" in message) {
        entry?.resolve(message.ok);
      } else {
        entry?.reject(message.err);
      }
    });
  });

  return {
    home,
    invoke(cmd, args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      });
    },
    async close() {
      child.stdin.end();
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
