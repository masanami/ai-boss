// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTauriByokKeyManager } from "./tauri-byok-key-manager";
import { ByokKeyCommandError } from "../byok-key-manager-context";

/**
 * キーの操作の Tauri 実装（#581 S3）。コマンドの名前・引数の名前は Rust の
 * `native/tauri-app/tests/secure_commands.rs` と同じ値。
 */

function recordingInvoke(result: (command: string) => unknown) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    return result(command);
  };
  return { invoke, calls };
}

describe("createTauriByokKeyManager（OpenAI・#582 S2）", () => {
  it("S2-T1: OpenAI のキーの操作で登録すると、byok_key_set が provider openai とキーで呼ばれる", async () => {
    const { invoke, calls } = recordingInvoke(() => null);
    await createTauriByokKeyManager(invoke, "openai").register("sk-proj-x");
    expect(calls).toEqual([{ command: "byok_key_set", args: { provider: "openai", key: "sk-proj-x" } }]);
  });

  it("S2-T2: OpenAI のキーの操作で削除・登録の有無の確認をすると、byok_key_delete・byok_key_status が provider openai で呼ばれる", async () => {
    const { invoke, calls } = recordingInvoke(() => true);
    const manager = createTauriByokKeyManager(invoke, "openai");
    await manager.remove();
    expect(await manager.isRegistered()).toBe(true);
    expect(calls).toEqual([
      { command: "byok_key_delete", args: { provider: "openai" } },
      { command: "byok_key_status", args: { provider: "openai" } },
    ]);
  });

  it("S2-T3: Anthropic のキーの操作は、provider を明示しても省略しても byok_key_* を provider anthropic で呼ぶ", async () => {
    for (const manager of [createTauriByokKeyManagerFor("anthropic"), createTauriByokKeyManagerFor(undefined)]) {
      const { calls, ...rest } = manager;
      await rest.manager.register("sk-ant-x");
      await rest.manager.remove();
      await rest.manager.isRegistered();
      expect(calls).toEqual([
        { command: "byok_key_set", args: { provider: "anthropic", key: "sk-ant-x" } },
        { command: "byok_key_delete", args: { provider: "anthropic" } },
        { command: "byok_key_status", args: { provider: "anthropic" } },
      ]);
    }
  });

  it("OpenAI の失敗も種類と OSStatus を持つ ByokKeyCommandError になり、キーを含まない", async () => {
    const invoke = async () => {
      throw { kind: "key-store-failure", osStatus: -34018 };
    };
    const failure = await createTauriByokKeyManager(invoke, "openai").register("sk-proj-x").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ByokKeyCommandError);
    expect((failure as Error).message).not.toContain("sk-proj-x");
  });
});

function createTauriByokKeyManagerFor(provider: "anthropic" | undefined) {
  const { invoke, calls } = recordingInvoke(() => null);
  return { manager: createTauriByokKeyManager(invoke, provider), calls };
}

describe("createTauriByokKeyManager", () => {
  it("登録の有無は byok_key_status を provider anthropic で呼んだ真偽値", async () => {
    const { invoke, calls } = recordingInvoke(() => true);
    expect(await createTauriByokKeyManager(invoke).isRegistered()).toBe(true);
    expect(calls).toEqual([{ command: "byok_key_status", args: { provider: "anthropic" } }]);
  });

  it("登録は byok_key_set を provider anthropic とキーで呼ぶ", async () => {
    const { invoke, calls } = recordingInvoke(() => null);
    await createTauriByokKeyManager(invoke).register("sk-ant-x");
    expect(calls).toEqual([{ command: "byok_key_set", args: { provider: "anthropic", key: "sk-ant-x" } }]);
  });

  it("削除は byok_key_delete を provider anthropic で呼ぶ", async () => {
    const { invoke, calls } = recordingInvoke(() => null);
    await createTauriByokKeyManager(invoke).remove();
    expect(calls).toEqual([{ command: "byok_key_delete", args: { provider: "anthropic" } }]);
  });

  it("失敗は種類と OSStatus を持つ ByokKeyCommandError になる", async () => {
    const invoke = async () => {
      throw { kind: "key-store-failure", osStatus: -34018 };
    };
    const failure = await createTauriByokKeyManager(invoke).register("sk-ant-x").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ByokKeyCommandError);
    expect(failure).toMatchObject({ kind: "key-store-failure", osStatus: -34018 });
    expect((failure as Error).message).toContain("-34018");
    expect((failure as Error).message).not.toContain("sk-ant-x");
  });
});
