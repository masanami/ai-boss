import { afterEach, describe, expect, it } from "vitest";
import { registerDevLlmBackends } from "./dev-llm-backends.js";
import {
  getLlmBackendImplementation,
  registeredLlmBackendNames,
  resetLlmBackendRegistryForTest,
} from "./llm-backend-registry.js";

/**
 * 機能仕様 docs/features/secure-transport-byok.md 受入基準（S2）「能力の
 * 宣言」: `registerDevLlmBackends()` が登録する `api`/`claude-code` の
 * 実装が、それぞれ正しい能力を宣言することを固定する。
 */
describe("registerDevLlmBackends — capabilities", () => {
  afterEach(() => {
    resetLlmBackendRegistryForTest();
  });

  it("registers the api implementation declaring it does not run its own tool loop, supports tool-choice forcing, and can limit response length", () => {
    registerDevLlmBackends();
    const implementation = getLlmBackendImplementation("api");
    expect(implementation?.capabilities).toEqual({
      runsOwnToolLoop: false,
      supportsToolChoice: true,
      limitsResponseLength: true,
    });
  });

  it("registers the claude-code implementation declaring it runs its own tool loop, does not support tool-choice forcing, and cannot limit response length", () => {
    registerDevLlmBackends();
    const implementation = getLlmBackendImplementation("claude-code");
    expect(implementation?.capabilities).toEqual({
      runsOwnToolLoop: true,
      supportsToolChoice: false,
      limitsResponseLength: false,
    });
  });

  it("registers exactly api and claude-code — the developer edition never registers byok-anthropic", () => {
    registerDevLlmBackends();
    expect(registeredLlmBackendNames().sort()).toEqual(["api", "claude-code"]);
  });
});
