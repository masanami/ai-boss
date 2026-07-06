import { describe, expect, it } from "vitest";
import { SUBMIT_VERDICT_TOOL, parseVerdictToolInput } from "./verdict-tool.js";

describe("SUBMIT_VERDICT_TOOL", () => {
  it("is named submit_verdict and requires verdict and response", () => {
    expect(SUBMIT_VERDICT_TOOL.name).toBe("submit_verdict");
    expect(SUBMIT_VERDICT_TOOL.input_schema.required).toEqual([
      "verdict",
      "response",
    ]);
  });

  it("restricts verdict to upheld/revised", () => {
    const schema = SUBMIT_VERDICT_TOOL.input_schema as {
      properties: { verdict: { enum: string[] } };
    };
    expect(schema.properties.verdict.enum).toEqual(["upheld", "revised"]);
  });
});

describe("parseVerdictToolInput", () => {
  it("rejects a non-object input", () => {
    const result = parseVerdictToolInput("not an object");

    expect(result.valid).toBe(false);
  });

  it("rejects an invalid verdict value", () => {
    const result = parseVerdictToolInput({
      verdict: "maybe",
      response: "検討中",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a missing or empty response", () => {
    const result = parseVerdictToolInput({ verdict: "upheld" });

    expect(result.valid).toBe(false);
  });

  it("accepts an upheld verdict without revised_content", () => {
    const result = parseVerdictToolInput({
      verdict: "upheld",
      response: "決定は維持する。理由は妥当だからだ。",
    });

    expect(result).toEqual({
      valid: true,
      data: {
        verdict: "upheld",
        response: "決定は維持する。理由は妥当だからだ。",
        revisedContent: undefined,
        revisedRationale: undefined,
      },
    });
  });

  it("rejects a revised verdict missing revised_content", () => {
    const result = parseVerdictToolInput({
      verdict: "revised",
      response: "修正する",
    });

    expect(result.valid).toBe(false);
  });

  it("rejects a revised verdict with an empty revised_content", () => {
    const result = parseVerdictToolInput({
      verdict: "revised",
      response: "修正する",
      revised_content: "   ",
    });

    expect(result.valid).toBe(false);
  });

  it("accepts a revised verdict with revised_content and revised_rationale", () => {
    const result = parseVerdictToolInput({
      verdict: "revised",
      response: "検討の結果、修正する",
      revised_content: "明日までに資料作成を完了する",
      revised_rationale: "進言の内容が妥当なため",
    });

    expect(result).toEqual({
      valid: true,
      data: {
        verdict: "revised",
        response: "検討の結果、修正する",
        revisedContent: "明日までに資料作成を完了する",
        revisedRationale: "進言の内容が妥当なため",
      },
    });
  });
});
