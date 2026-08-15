import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveLlmBackend } from "./config.js";

describe("loadConfig", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults port to 8787 when PORT is not set", () => {
    const config = loadConfig({});

    expect(config.port).toBe(8787);
  });

  it("uses PORT from env when set", () => {
    const config = loadConfig({ PORT: "3000" });

    expect(config.port).toBe(3000);
  });

  it("falls back to the default port and warns when PORT is not a valid number", () => {
    const config = loadConfig({ PORT: "not-a-number" });

    expect(config.port).toBe(8787);
    expect(console.warn).toHaveBeenCalled();
  });

  it("falls back to the default port and warns when PORT is zero or negative", () => {
    const config = loadConfig({ PORT: "-1" });

    expect(config.port).toBe(8787);
    expect(console.warn).toHaveBeenCalled();
  });

  it("defaults dbPath to ./data/ai-boss.db when DB_PATH is not set", () => {
    const config = loadConfig({});

    expect(config.dbPath).toBe("./data/ai-boss.db");
  });

  it("uses DB_PATH from env when set", () => {
    const config = loadConfig({ DB_PATH: "./tmp/test.db" });

    expect(config.dbPath).toBe("./tmp/test.db");
  });

  it("reports hasAnthropicApiKey as false and warns when ANTHROPIC_API_KEY is not set (api backend)", () => {
    const config = loadConfig({ LLM_BACKEND: "api" });

    expect(config.hasAnthropicApiKey).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("reports hasAnthropicApiKey as true and never logs the key value when ANTHROPIC_API_KEY is set", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const secretKey = "sk-ant-super-secret-value";

    const config = loadConfig({ ANTHROPIC_API_KEY: secretKey });

    expect(config.hasAnthropicApiKey).toBe(true);
    const allLoggedArgs = [...logSpy.mock.calls, ...vi.mocked(console.warn).mock.calls]
      .flat()
      .join(" ");
    expect(allLoggedArgs).not.toContain(secretKey);
  });

  it("defaults llmBackend to claude-code when LLM_BACKEND is not set (Issue #118)", () => {
    const config = loadConfig({});

    expect(config.llmBackend).toBe("claude-code");
  });

  it("uses llmBackend as api when LLM_BACKEND=api is set", () => {
    const config = loadConfig({ LLM_BACKEND: "api" });

    expect(config.llmBackend).toBe("api");
  });

  it("uses llmBackend as claude-code when LLM_BACKEND=claude-code is set", () => {
    const config = loadConfig({ LLM_BACKEND: "claude-code" });

    expect(config.llmBackend).toBe("claude-code");
  });

  it("throws with an error message including the allowed values when LLM_BACKEND is invalid", () => {
    expect(() => loadConfig({ LLM_BACKEND: "invalid-value" })).toThrow(
      /api.*claude-code|claude-code.*api/,
    );
  });

  it("throws with an error message including the allowed values when LLM_BACKEND is an empty string", () => {
    expect(() => loadConfig({ LLM_BACKEND: "" })).toThrow(
      /api.*claude-code|claude-code.*api/,
    );
  });

  it("does not warn about ANTHROPIC_API_KEY when llmBackend is claude-code", () => {
    loadConfig({ LLM_BACKEND: "claude-code" });

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("logs the effective llmBackend once at startup, noting it is the default (Issue #118)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig({});

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = logSpy.mock.calls[0].join(" ");
    expect(logged).toContain("claude-code");
    // バックエンド名だけを見ると、既定/明示の区別が消えても気付けない。
    // 起動ログの外部契約として区別の文言そのものを固定する。
    expect(logged).toContain("既定値");
  });

  it("logs the effective llmBackend once at startup, noting LLM_BACKEND was set explicitly (Issue #118)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    loadConfig({ LLM_BACKEND: "api", ANTHROPIC_API_KEY: "sk-ant-test-key" });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = logSpy.mock.calls[0].join(" ");
    expect(logged).toContain("api");
    expect(logged).toContain("LLM_BACKEND で明示");
  });

  it("warns to set LLM_BACKEND=api when the default claude-code backend is in effect and ANTHROPIC_API_KEY is set (Issue #118)", () => {
    loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test-key" });

    expect(console.warn).toHaveBeenCalled();
    const warned = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(warned).toContain("LLM_BACKEND=api");
  });

  it("does not warn about switching backends when ANTHROPIC_API_KEY is not set (Issue #118)", () => {
    loadConfig({});

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not warn about switching backends when LLM_BACKEND=api is set explicitly even if ANTHROPIC_API_KEY is set (Issue #118)", () => {
    loadConfig({ LLM_BACKEND: "api", ANTHROPIC_API_KEY: "sk-ant-test-key" });

    expect(console.warn).not.toHaveBeenCalled();
  });

  // 明示 claude-code ＋ API キーあり。切替警告は「既定で claude-code に
  // なっているが API キーがある」ケース向けなので、明示指定なら出ない。
  it("does not warn about switching backends when LLM_BACKEND=claude-code is set explicitly even if ANTHROPIC_API_KEY is set (Issue #118)", () => {
    loadConfig({
      LLM_BACKEND: "claude-code",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
    });

    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("resolveLlmBackend", () => {
  it("resolves to claude-code when LLM_BACKEND is not set (Issue #118 — new default; used directly by boss-comment.ts/notification-body.ts)", () => {
    expect(resolveLlmBackend({})).toBe("claude-code");
  });

  it("resolves to claude-code when LLM_BACKEND=claude-code", () => {
    expect(resolveLlmBackend({ LLM_BACKEND: "claude-code" })).toBe("claude-code");
  });

  it("resolves to api when LLM_BACKEND=api is set (Issue #118 — back-compat)", () => {
    expect(resolveLlmBackend({ LLM_BACKEND: "api" })).toBe("api");
  });

  it("throws with an error message including the allowed values for an invalid value", () => {
    expect(() => resolveLlmBackend({ LLM_BACKEND: "invalid-value" })).toThrow(
      /api.*claude-code|claude-code.*api/,
    );
  });
});
