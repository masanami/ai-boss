import { afterEach, describe, expect, it } from "vitest";
import {
  LlmSelectionNotConfiguredError,
  devLlmSelectionResolver,
  productLlmSelectionResolver,
  resetLlmSelectionResolverForTest,
  resolveLlmSelection,
  setLlmSelectionResolver,
} from "./llm-selection.js";

/**
 * 受入基準（S3）S3-S1〜S3-S4（機能仕様 docs/features/secure-transport-byok.md
 * クリティカル設計決定 7）と、S3-S5・S3-S6 を置き換えた受入基準（S2）S2-S1〜S2-S9
 * （docs/features/llm-provider-abstraction.md）。
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

describe("製品版の解決関数（#582 S2）", () => {
  const selection = (provider: string | undefined, model?: string, extra: Array<[string, string]> = []) => {
    const map = new Map<string, string>(extra);
    if (provider !== undefined) map.set("byok_provider", provider);
    if (model !== undefined) map.set("byok_model", model);
    return map;
  };

  // S3-S5・S3-S6 の置き換え（S2-X1）: 常に byok-anthropic と設定の model を返す
  // 固定の関数から、保存した選択で決める関数へ。
  it("S2-S1: 選択 anthropic・claude-haiku-4-5 では byok-anthropic と claude-haiku-4-5 を返す", () => {
    expect(productLlmSelectionResolver({}, selection("anthropic", "claude-haiku-4-5"))).toEqual({
      backend: "byok-anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("S2-S2: 選択 openai・gpt-6-luna では byok-openai と gpt-6-luna を返す", () => {
    expect(productLlmSelectionResolver({}, selection("openai", "gpt-6-luna"))).toEqual({
      backend: "byok-openai",
      model: "gpt-6-luna",
    });
  });

  it("S2-S3: byok_provider が無いと「未選択」の例外を投げる（設定の model があっても同じ）", () => {
    expect(() => productLlmSelectionResolver({}, selection(undefined, "gpt-6-luna"))).toThrow(
      LlmSelectionNotConfiguredError,
    );
    expect(() => productLlmSelectionResolver({}, new Map())).toThrow(LlmSelectionNotConfiguredError);
    expect(() =>
      productLlmSelectionResolver({}, selection(undefined, undefined, [["model", "claude-sonnet-5"]])),
    ).toThrow(LlmSelectionNotConfiguredError);
  });

  it("S2-S4: byok_provider が google・空の文字列だと「未選択」の例外を投げる", () => {
    expect(() => productLlmSelectionResolver({}, selection("google", "gpt-6-luna"))).toThrow(
      LlmSelectionNotConfiguredError,
    );
    expect(() => productLlmSelectionResolver({}, selection("", "gpt-6-luna"))).toThrow(
      LlmSelectionNotConfiguredError,
    );
  });

  it("S2-S5: byok_provider が openai でも byok_model が無い（空の文字列）と「未選択」の例外を投げる", () => {
    expect(() => productLlmSelectionResolver({}, selection("openai"))).toThrow(LlmSelectionNotConfiguredError);
    expect(() => productLlmSelectionResolver({}, selection("openai", ""))).toThrow(
      LlmSelectionNotConfiguredError,
    );
  });

  it("S2-S6: 一覧に無いモデル（openai・gpt-6-astra）は補正せずそのまま返す", () => {
    expect(productLlmSelectionResolver({}, selection("openai", "gpt-6-astra"))).toEqual({
      backend: "byok-openai",
      model: "gpt-6-astra",
    });
  });

  it("S2-S7: LLM_BACKEND=api の env を渡しても保存した選択のバックエンドを返す", () => {
    expect(productLlmSelectionResolver({ LLM_BACKEND: "api" }, selection("openai", "gpt-6-sol")).backend).toBe(
      "byok-openai",
    );
    expect(
      productLlmSelectionResolver({ LLM_BACKEND: "claude-code" }, selection("anthropic", "claude-sonnet-5")).backend,
    ).toBe("byok-anthropic");
  });

  it("S2-S8: 設定の model（claude-opus-5-5）ではなく byok_model（gpt-6-sol）を返す", () => {
    expect(
      productLlmSelectionResolver({}, selection("openai", "gpt-6-sol", [["model", "claude-opus-5-5"]])).model,
    ).toBe("gpt-6-sol");
  });

  it("「未選択」の例外の文言は選ぶ場所を案内し、保存値のモデルや秘密を含まない", () => {
    let error: unknown;
    try {
      productLlmSelectionResolver({ ANTHROPIC_API_KEY: "sk-ant-secret" }, new Map());
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LlmSelectionNotConfiguredError);
    const message = (error as Error).message;
    expect(message).toContain("設定");
    expect(message).not.toContain("sk-ant-secret");
  });

  it("登録すると resolveLlmSelection が製品版の解決関数を使う", () => {
    setLlmSelectionResolver(productLlmSelectionResolver);
    expect(resolveLlmSelection({ LLM_BACKEND: "api" }, selection("openai", "gpt-6-luna"))).toEqual({
      backend: "byok-openai",
      model: "gpt-6-luna",
    });
  });
});

describe("開発者用の解決関数は byok_* を読まない（#582 S2）", () => {
  it("S2-S9: LLM_BACKEND の無い env で選択 openai・gpt-6-sol を保存していても claude-code と設定の model を返す", () => {
    const snapshot = new Map([
      ["byok_provider", "openai"],
      ["byok_model", "gpt-6-sol"],
      ["model", "claude-opus-5-5"],
    ]);
    expect(devLlmSelectionResolver({}, snapshot)).toEqual({
      backend: "claude-code",
      model: "claude-opus-5-5",
    });
  });
});
