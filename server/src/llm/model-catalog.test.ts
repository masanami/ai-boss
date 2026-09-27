import { describe, expect, it } from "vitest";
import {
  ByokModelNotAllowedError,
  MODEL_CATALOG,
  assertByokModelAllowed,
  getDefaultModelId,
  getOpenAiReasoningEffort,
  listModelsForProvider,
} from "./model-catalog.js";

/**
 * BYOK で許可するモデルの一覧（機能仕様 docs/features/llm-provider-abstraction.md
 * クリティカル設計決定3・受入基準（S1）「モデルの一覧と送信前の関門」）。
 */

describe("モデルの一覧", () => {
  it("Anthropic の行は claude-sonnet-5 と claude-haiku-4-5 の2行だけである", () => {
    const ids = listModelsForProvider("anthropic").map((entry) => entry.modelId);
    expect(ids.sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5"].sort());
  });

  it("Anthropic の既定は claude-sonnet-5 である", () => {
    expect(getDefaultModelId("anthropic")).toBe("claude-sonnet-5");
  });

  it("OpenAI の行は gpt-6-sol と gpt-6-luna の2行だけである", () => {
    const ids = listModelsForProvider("openai").map((entry) => entry.modelId);
    expect(ids.sort()).toEqual(["gpt-6-luna", "gpt-6-sol"].sort());
  });

  it("OpenAI の既定は gpt-6-sol である", () => {
    expect(getDefaultModelId("openai")).toBe("gpt-6-sol");
  });

  it("MODEL_CATALOG はちょうど4行である（2プロバイダ × 2モデル）", () => {
    expect(MODEL_CATALOG).toHaveLength(4);
  });
});

describe("assertByokModelAllowed（送信前の関門）", () => {
  it("一覧にある Anthropic のモデルは例外を投げない", () => {
    expect(() => assertByokModelAllowed("anthropic", "claude-sonnet-5")).not.toThrow();
    expect(() => assertByokModelAllowed("anthropic", "claude-haiku-4-5")).not.toThrow();
  });

  it("一覧にある OpenAI のモデルは例外を投げない", () => {
    expect(() => assertByokModelAllowed("openai", "gpt-6-sol")).not.toThrow();
    expect(() => assertByokModelAllowed("openai", "gpt-6-luna")).not.toThrow();
  });

  it("一覧に無い OpenAI のモデル（例: gpt-6-astra）は ByokModelNotAllowedError を投げる", () => {
    expect(() => assertByokModelAllowed("openai", "gpt-6-astra")).toThrow(ByokModelNotAllowedError);
  });

  it("一覧に無い Anthropic のモデル（例: claude-opus-5-5）は ByokModelNotAllowedError を投げる", () => {
    expect(() => assertByokModelAllowed("anthropic", "claude-opus-5-5")).toThrow(ByokModelNotAllowedError);
  });

  it("他方のプロバイダの一覧にあるモデルは拒否する（openai に claude-sonnet-5）", () => {
    expect(() => assertByokModelAllowed("openai", "claude-sonnet-5")).toThrow(ByokModelNotAllowedError);
  });

  it("他方のプロバイダの一覧にあるモデルは拒否する（anthropic に gpt-6-sol）", () => {
    expect(() => assertByokModelAllowed("anthropic", "gpt-6-sol")).toThrow(ByokModelNotAllowedError);
  });

  it("投げる例外は provider・modelId を保持する", () => {
    try {
      assertByokModelAllowed("openai", "gpt-6-astra");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ByokModelNotAllowedError);
      expect((err as ByokModelNotAllowedError).provider).toBe("openai");
      expect((err as ByokModelNotAllowedError).modelId).toBe("gpt-6-astra");
    }
  });
});

describe("getOpenAiReasoningEffort（OpenAI の reasoning.effort の対応）", () => {
  it("gpt-6-sol の chat（thinking: adaptive）は low である", () => {
    expect(getOpenAiReasoningEffort("gpt-6-sol", "chat")).toBe("low");
  });

  it("gpt-6-sol の disabled（thinking: disabled）は none である", () => {
    expect(getOpenAiReasoningEffort("gpt-6-sol", "disabled")).toBe("none");
  });

  it("gpt-6-luna の chat/disabled も同じ対応である", () => {
    expect(getOpenAiReasoningEffort("gpt-6-luna", "chat")).toBe("low");
    expect(getOpenAiReasoningEffort("gpt-6-luna", "disabled")).toBe("none");
  });

  it("一覧に無いモデルを渡すと ByokModelNotAllowedError を投げる", () => {
    expect(() => getOpenAiReasoningEffort("gpt-6-astra", "chat")).toThrow(ByokModelNotAllowedError);
  });
});
