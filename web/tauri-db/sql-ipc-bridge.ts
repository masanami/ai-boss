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
 * #579 S4（仮定 A14）: 名前は変えずに、raw の本文（plugin-fs の `writeFile`）・
 * ヘッダ・raw の応答（`readFile`）の受け渡しを足した。本文が `Uint8Array` なら
 * base64 で `raw` に載せ、応答が `raw` なら `ArrayBuffer` で返す（実際の
 * `__TAURI_INTERNALS__.invoke` と同じ）。
 *
 * 中継は起動のたびに新しい一時ディレクトリを `HOME` にして器を組むため、
 * 起動ごとに空の DB（アプリのデータディレクトリの `ai-boss.db`）で始まり、
 * 利用者のアプリのデータディレクトリには触れない。中継のバイナリは
 * `npm run test:tauri-db` の前処理（`pretest:tauri-db`）がビルドする。
 */

const BRIDGE_BINARY = fileURLToPath(
  new URL("../../native/tauri-app/target/debug/examples/sql-ipc-bridge", import.meta.url),
);

/** `close()` が中継の終了を待つ上限。過ぎたら強制終了する。 */
const CLOSE_TIMEOUT_MS = 5_000;

/** `invoke` の第 3 引数のうち、中継が運ぶもの（`writeFile` は `path`・`options` をヘッダで送る） */
export interface SqlIpcInvokeOptions {
  headers?: Record<string, string>;
}

export interface SqlIpcBridge {
  /** IPC の要求を送り、戻り値（エラーなら拒否）を返す。raw の応答は `ArrayBuffer` */
  invoke(cmd: string, args: unknown, options?: SqlIpcInvokeOptions): Promise<unknown>;
  /** 中継の `HOME`（一時ディレクトリ） */
  home: string;
  /** 中継を終わらせ、一時ディレクトリを消す */
  close(): Promise<void>;
}

type BridgeMessage =
  | { ready: true }
  | { id: number; ok: unknown }
  | { id: number; raw: string }
  | { id: number; err: unknown };

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
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  let nextId = 1;
  /** 中継が終わった（または起動に失敗した）理由。以後の要求は即座に拒否する。 */
  let stopped: Error | undefined;
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    });
  });

  function stop(reason: Error): void {
    stopped ??= reason;
    for (const entry of pending.values()) {
      entry.reject(stopped);
    }
    pending.clear();
  }

  // 終わった中継の標準入力へ書くと EPIPE になる。未処理の例外にせず、
  // 待っている要求を拒否する。
  child.stdin.on("error", (error) => stop(error));
  child.once("error", (error) => stop(error));
  void exited.then(() => stop(new Error(`the IPC bridge exited (code ${exitCode})`)));

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    child.once("error", rejectReady);
    void exited.then(() => rejectReady(stopped));
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
      } else if ("raw" in message) {
        const bytes = Buffer.from(message.raw, "base64");
        entry?.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else {
        entry?.reject(message.err);
      }
    });
  });

  async function close(): Promise<void> {
    if (exitCode === null && !child.killed) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    rmSync(home, { recursive: true, force: true });
  }

  try {
    await ready;
  } catch (error) {
    // 起動できなかった（spawn の失敗）ときは pid が無く、exit も来ない。
    if (child.pid !== undefined) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    home,
    invoke(cmd, args, options) {
      if (stopped) {
        return Promise.reject(stopped);
      }
      const id = nextId++;
      // 本文が バイト列なら raw で、そうでなければ JSON の引数で送る。
      const body =
        args instanceof ArrayBuffer || ArrayBuffer.isView(args)
          ? { raw: Buffer.from(args instanceof ArrayBuffer ? args : args.buffer.slice(args.byteOffset, args.byteOffset + args.byteLength)).toString("base64") }
          : { args };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, cmd, ...body, headers: options?.headers })}\n`);
      });
    },
    close,
  };
}

/**
 * `window.__TAURI_INTERNALS__.invoke` を中継へ差し替える（`@tauri-apps/api/mocks`
 * の `mockIPC` は `invoke` の第 3 引数〔ヘッダ〕を捨てるため、`writeFile` は
 * 通せない）。JS のプラグイン（`@tauri-apps/plugin-fs` ほか）は本物のまま動き、
 * 置き換わるのは WebView と Rust の間の転送だけ。流れた要求の記録を返す。
 * node の環境では `window` が無いので、グローバルを `window` として見せる。
 */
export function installBridgeInternals(
  bridge: SqlIpcBridge,
  stubGlobal: (name: string, value: unknown) => void,
): { commands: { cmd: string; args: unknown }[]; uninstall(): void } {
  const commands: { cmd: string; args: unknown }[] = [];
  stubGlobal("window", globalThis);
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown, options?: SqlIpcInvokeOptions) => {
      commands.push({ cmd, args });
      return bridge.invoke(cmd, args ?? {}, options);
    },
  };
  return {
    commands,
    uninstall() {
      delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    },
  };
}
