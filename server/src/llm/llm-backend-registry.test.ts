import { afterEach, describe, expect, it } from "vitest";
import {
  getLlmBackendImplementation,
  registeredLlmBackendNames,
  registerLlmBackend,
  resetLlmBackendRegistryForTest,
  type LlmBackendImplementation,
} from "./llm-backend-registry.js";

/**
 * LLM バックエンドの注入レジストリ（機能仕様
 * docs/features/tauri-in-app-runtime.md クリティカル設計決定3・実装計画①）
 * 単体の契約: 登録・列挙・参照・（テスト用）リセット。
 *
 * バックエンドごとの実際の実装（`api`/`claude-code`）の配線は
 * `llm/dev-llm-backends.ts` と `llm/claude-client.test.ts` が担う — ここでは
 * レジストリのデータ構造としての振る舞いだけを検証する。
 */

function makeFakeImplementation(): LlmBackendImplementation {
  return {
    createClient: () => ({ backend: "api", client: {} as never }),
    streamRound: async () => ({ content: [] }),
    createRound: async () => ({ content: [] }),
  };
}

describe("llm-backend-registry", () => {
  afterEach(() => {
    resetLlmBackendRegistryForTest();
  });

  it("returns undefined for an unregistered backend", () => {
    expect(getLlmBackendImplementation("api")).toBeUndefined();
  });

  it("returns an empty array when nothing is registered", () => {
    expect(registeredLlmBackendNames()).toEqual([]);
  });

  it("returns the registered implementation by name", () => {
    const implementation = makeFakeImplementation();

    registerLlmBackend("api", implementation);

    expect(getLlmBackendImplementation("api")).toBe(implementation);
  });

  it("lists every registered backend name", () => {
    registerLlmBackend("api", makeFakeImplementation());
    registerLlmBackend("claude-code", makeFakeImplementation());

    expect(registeredLlmBackendNames().sort()).toEqual(["api", "claude-code"]);
  });

  it("overwrites a previously registered implementation for the same name (idempotent re-registration)", () => {
    const first = makeFakeImplementation();
    const second = makeFakeImplementation();

    registerLlmBackend("api", first);
    registerLlmBackend("api", second);

    expect(getLlmBackendImplementation("api")).toBe(second);
    expect(registeredLlmBackendNames()).toEqual(["api"]);
  });

  it("clears every registration via resetLlmBackendRegistryForTest", () => {
    registerLlmBackend("api", makeFakeImplementation());
    registerLlmBackend("claude-code", makeFakeImplementation());

    resetLlmBackendRegistryForTest();

    expect(registeredLlmBackendNames()).toEqual([]);
  });
});
