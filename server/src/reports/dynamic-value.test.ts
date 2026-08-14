import { describe, expect, it } from "vitest";
import { normalizeDynamicValue } from "./dynamic-value.js";

describe("normalizeDynamicValue", () => {
  it("returns a plain single-line value unchanged", () => {
    expect(normalizeDynamicValue("資料作成")).toBe("資料作成");
  });

  it("replaces LF with a single half-width space", () => {
    expect(normalizeDynamicValue("1行目\n2行目")).toBe("1行目 2行目");
  });

  it("replaces CRLF with a single half-width space", () => {
    expect(normalizeDynamicValue("1行目\r\n2行目")).toBe("1行目 2行目");
  });

  it("replaces a lone CR with a single half-width space", () => {
    expect(normalizeDynamicValue("1行目\r2行目")).toBe("1行目 2行目");
  });

  it("collapses consecutive whitespace produced by multiple newlines into one space", () => {
    expect(normalizeDynamicValue("1行目\n\n\n2行目")).toBe("1行目 2行目");
  });

  it("collapses pre-existing consecutive half-width spaces into one", () => {
    expect(normalizeDynamicValue("1行目   2行目")).toBe("1行目 2行目");
  });

  it.each([["#"], ["-"], ["*"], ["+"], [">"], ["|"]])(
    "escapes a leading markdown symbol (%s) with a backslash",
    (symbol) => {
      expect(normalizeDynamicValue(`${symbol} 見出し風`)).toBe(`\\${symbol} 見出し風`);
    },
  );

  it("escapes a leading '1.' numbered-list marker before the period only", () => {
    expect(normalizeDynamicValue("1. 最初の項目")).toBe("1\\. 最初の項目");
  });

  it("escapes a leading multi-digit numbered-list marker (e.g. '12.')", () => {
    expect(normalizeDynamicValue("12. 項目")).toBe("12\\. 項目");
  });

  it("does not escape a symbol that is not at the start of the value", () => {
    expect(normalizeDynamicValue("これは # 見出しではない")).toBe(
      "これは # 見出しではない",
    );
  });

  it("does not escape a digit sequence without a trailing period", () => {
    expect(normalizeDynamicValue("2026年の目標")).toBe("2026年の目標");
  });

  it("escapes the leading symbol after newline normalization (symbol appears only after joining)", () => {
    expect(normalizeDynamicValue("\n- 見出し風")).toBe("\\- 見出し風");
  });

  it("trims leading and trailing whitespace produced by normalization", () => {
    expect(normalizeDynamicValue("  前後に空白  ")).toBe("前後に空白");
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeDynamicValue("")).toBe("");
  });
});
