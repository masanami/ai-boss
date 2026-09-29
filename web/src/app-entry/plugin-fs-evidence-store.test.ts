// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { createPluginFsEvidenceStore } from "./plugin-fs-evidence-store";

/**
 * 製品版の証跡の保存の実装（plugin-fs）の写像（#579 S4・機能仕様
 * docs/features/tauri-in-app-runtime.md 受入基準（S4）AC-S4-20〜24）。
 *
 * `@tauri-apps/plugin-fs`（JS。上流のまま）が呼ぶ `invoke` の先
 * （`__TAURI_INTERNALS__.invoke`）を記録用に差し替え、IPC の要求の引数で確かめる。
 * `@tauri-apps/api/mocks` の `mockIPC` は `invoke` の第 3 引数（`writeFile` が
 * `path`・`options` を載せるヘッダ）を捨てるため使わない。実際の plugin-fs
 * （Rust）の上で同じ実装を回すのは `web/tauri-db/`（`npm run test:tauri-db`）。
 */

const UUID = "0b8f3c1e-52a4-4f7d-9d3e-1a2b3c4d5e6f";
const VALID_NAME = `${UUID}.png`;

/** AC-S4-20 の保存名の形に通らない例（`../x.png` ほか、機能仕様に列挙されたもの） */
const INVALID_NAMES = [
  "../x.png",
  "/etc/hosts",
  "a/b.png",
  "a\\b.png",
  `${UUID}.PNG`,
  `${UUID.toUpperCase()}.png`,
  `${UUID}.exe`,
  UUID,
  "",
];

interface RecordedInvoke {
  cmd: string;
  args: unknown;
  options: { headers?: Record<string, string> } | undefined;
}

let calls: RecordedInvoke[];
let respond: (call: RecordedInvoke) => unknown;

beforeEach(() => {
  calls = [];
  respond = () => undefined;
  vi.stubGlobal("window", globalThis);
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: unknown, options: RecordedInvoke["options"]) => {
      const call = { cmd, args, options };
      calls.push(call);
      return respond(call);
    },
  };
});

afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe("createPluginFsEvidenceStore: 保存名の形の検査（多層防御）", () => {
  it.each(INVALID_NAMES)("AC-S4-20: 形に通らない保存名 %j は write・read・remove のどれでも IPC を呼ばない", async (name) => {
    const store = createPluginFsEvidenceStore();

    await Promise.allSettled([
      Promise.resolve(store.write(name, new Uint8Array([1]))),
      Promise.resolve(store.read(name)),
      Promise.resolve(store.remove(name)),
    ]);

    expect(calls).toEqual([]);
  });

  it.each(INVALID_NAMES)("AC-S4-21: 形に通らない保存名 %j の write は例外で失敗する", async (name) => {
    const store = createPluginFsEvidenceStore();

    await expect(Promise.resolve().then(() => store.write(name, new Uint8Array([1])))).rejects.toThrow();
  });

  it.each(INVALID_NAMES)("AC-S4-22: 形に通らない保存名 %j の read は undefined を返す", async (name) => {
    const store = createPluginFsEvidenceStore();

    expect(await store.read(name)).toBeUndefined();
  });

  it.each(INVALID_NAMES)("AC-S4-23: 形に通らない保存名 %j の remove は失敗しない", async (name) => {
    const store = createPluginFsEvidenceStore();

    await expect(Promise.resolve().then(() => store.remove(name))).resolves.toBeUndefined();
  });
});

describe("createPluginFsEvidenceStore: plugin-fs の呼び方 (AC-S4-24)", () => {
  it("write は plugin:fs|write_file を baseDir AppConfig と相対パス evidence/<保存名> で呼び、本文をそのまま渡す", async () => {
    const data = new Uint8Array([1, 2, 3]);

    await createPluginFsEvidenceStore().write(VALID_NAME, data);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cmd).toBe("plugin:fs|write_file");
    expect(call?.args).toBe(data);
    // `writeFile` は path を URI エンコードして、options を JSON にしてヘッダで送る。
    expect(decodeURIComponent(call?.options?.headers?.path ?? "")).toBe(`evidence/${VALID_NAME}`);
    expect(JSON.parse(call?.options?.headers?.options ?? "null")).toEqual({ baseDir: BaseDirectory.AppConfig });
  });

  it("read は exists で有無を確かめてから plugin:fs|read_file を同じ baseDir・相対パスで呼び、バイト列を返す", async () => {
    respond = ({ cmd }) => (cmd === "plugin:fs|exists" ? true : new Uint8Array([7, 8, 9]).buffer);

    const bytes = await createPluginFsEvidenceStore().read(VALID_NAME);

    expect(calls.map((c) => c.cmd)).toEqual(["plugin:fs|exists", "plugin:fs|read_file"]);
    for (const call of calls) {
      expect(call.args).toEqual({
        path: `evidence/${VALID_NAME}`,
        options: { baseDir: BaseDirectory.AppConfig },
      });
    }
    expect(bytes).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("read は exists が false のとき read_file を呼ばず undefined を返す", async () => {
    respond = () => false;

    expect(await createPluginFsEvidenceStore().read(VALID_NAME)).toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual(["plugin:fs|exists"]);
  });

  it("remove は exists が true のとき plugin:fs|remove を同じ baseDir・相対パスで呼ぶ", async () => {
    respond = ({ cmd }) => (cmd === "plugin:fs|exists" ? true : undefined);

    await createPluginFsEvidenceStore().remove(VALID_NAME);

    expect(calls.map((c) => c.cmd)).toEqual(["plugin:fs|exists", "plugin:fs|remove"]);
    expect(calls[1]?.args).toEqual({
      path: `evidence/${VALID_NAME}`,
      options: { baseDir: BaseDirectory.AppConfig },
    });
  });

  it("remove は exists が false のとき何も消さず失敗しない（書いていない保存名の remove）", async () => {
    respond = () => false;

    await expect(createPluginFsEvidenceStore().remove(VALID_NAME)).resolves.toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual(["plugin:fs|exists"]);
  });
});

describe("createPluginFsEvidenceStore: 検査を通った保存名での IPC の失敗は伝える (A12)", () => {
  type Store = ReturnType<typeof createPluginFsEvidenceStore>;

  it.each([
    ["write", "plugin:fs|write_file", (s: Store) => s.write(VALID_NAME, new Uint8Array([1]))],
    ["read", "plugin:fs|exists", (s: Store) => s.read(VALID_NAME)],
    ["remove", "plugin:fs|exists", (s: Store) => s.remove(VALID_NAME)],
  ])("%s は最初の IPC（%s）が拒否されたら同じ理由で失敗する（握りつぶさない）", async (_name, firstCmd, run) => {
    respond = () => {
      throw "forbidden path";
    };

    await expect(Promise.resolve().then(() => run(createPluginFsEvidenceStore()))).rejects.toBe("forbidden path");
    expect(calls.map((c) => c.cmd)).toEqual([firstCmd]);
  });

  // `read`・`remove` は先に `exists` を呼ぶ。`exists` は通し、その後の本体の IPC だけを
  // 失敗させる（一律に失敗させると `exists` で止まり、本体の失敗の扱いを確かめられない）。
  it.each([
    ["read", "plugin:fs|read_file", (s: Store) => s.read(VALID_NAME)],
    ["remove", "plugin:fs|remove", (s: Store) => s.remove(VALID_NAME)],
  ])("%s は exists が true の後の %s が拒否されたら同じ理由で失敗する（undefined・成功に変えない）", async (_name, failingCmd, run) => {
    respond = ({ cmd }) => {
      if (cmd === "plugin:fs|exists") {
        return true;
      }
      throw "forbidden path";
    };

    await expect(Promise.resolve().then(() => run(createPluginFsEvidenceStore()))).rejects.toBe("forbidden path");
    expect(calls.map((c) => c.cmd)).toEqual(["plugin:fs|exists", failingCmd]);
  });
});
