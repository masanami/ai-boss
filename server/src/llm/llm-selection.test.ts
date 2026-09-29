import { afterEach, describe, expect, it } from "vitest";
import {
  devLlmSelectionResolver,
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  resolveLlmSelection,
  setLlmSelectionResolver,
} from "./llm-selection.js";

/**
 * 受入基準（S3）S3-S1〜S3-S6（機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定 7）。
 */

const noModel = new Map<string, string>();
const withModel = new Map([["model", "claude-haiku-4-5"]]);

afterEach(() => {
  resetLlmSelectionResolverForTest();
});

describe("解決関数を登録していないとき（開発者用の解決関数）", () => {
  it("S3-S1: LLM_BACKEND の無い env では claude-code", () => {
    expect(resolveLlmSelection({}, noModel).backend).toBe("claude-code");
  });

  it("S3-S2: LLM_BACKEND=api では api", () => {
    expect(resolveLlmSelection({ LLM_BACKEND: "api" }, noModel).backend).toBe("api");
  });

  it("S3-S3: LLM_BACKEND=byok-anthropic は例外で失敗する", () => {
    expect(() => resolveLlmSelection({ LLM_BACKEND: "byok-anthropic" }, noModel)).toThrow();
  });

  it("S3-S4: モデルは設定の model（無ければ claude-sonnet-5）", () => {
    expect(resolveLlmSelection({}, withModel).model).toBe("claude-haiku-4-5");
    expect(resolveLlmSelection({}, noModel).model).toBe("claude-sonnet-5");
  });

  it("登録していないときに使われるのは開発者用の解決関数と同じ結果", () => {
    expect(resolveLlmSelection({ LLM_BACKEND: "api" }, withModel)).toEqual(
      devLlmSelectionResolver({ LLM_BACKEND: "api" }, withModel),
    );
  });
});

describe("製品版の解決関数", () => {
  it("S3-S5: LLM_BACKEND=api の env を渡しても byok-anthropic を返す", () => {
    expect(productLlmSelectionResolver({ LLM_BACKEND: "api" }, noModel).backend).toBe("byok-anthropic");
  });

  it("S3-S6: モデルは設定の model（無ければ claude-sonnet-5）", () => {
    expect(productLlmSelectionResolver({}, withModel).model).toBe("claude-haiku-4-5");
    expect(productLlmSelectionResolver({}, noModel).model).toBe("claude-sonnet-5");
  });

  it("登録すると resolveLlmSelection が製品版の解決関数を使う", () => {
    setLlmSelectionResolver(productLlmSelectionResolver);
    expect(resolveLlmSelection({ LLM_BACKEND: "api" }, noModel)).toEqual({
      backend: "byok-anthropic",
      model: "claude-sonnet-5",
    });
  });
});
