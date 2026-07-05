import type Anthropic from "@anthropic-ai/sdk";
import { APPEAL_VERDICTS, type AppealVerdict } from "./appeal.js";

/**
 * Tool forced (via `tool_choice`) on the boss when re-adjudicating an appeal
 * (Issue #48). Kept separate from the task-operation tools (`boss-tools.ts`)
 * on purpose: the verdict round has no access to task tools, so the boss
 * cannot reflect a revised decision onto a task directly (explicit
 * assumption — see the ticket).
 */
export const SUBMIT_VERDICT_TOOL: Anthropic.Tool = {
  name: "submit_verdict",
  description:
    "進言（異議申し立て）を検討した結果の裁定を提出する。維持(upheld)か修正(revised)かを明示し、必ずユーザー向けの再裁定文(response)を添えること。" +
    "verdict が revised の場合は修正後の決定内容(revised_content)を必ず含めること。",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: [...APPEAL_VERDICTS],
        description: "裁定結果。維持なら upheld、修正するなら revised。",
      },
      response: {
        type: "string",
        description: "ボスの再裁定文（ユーザーに提示する説明・断言）",
      },
      revised_content: {
        type: "string",
        description: "verdict が revised の場合の修正後の決定内容（必須）",
      },
      revised_rationale: {
        type: "string",
        description: "修正の根拠",
      },
    },
    required: ["verdict", "response"],
  },
};

export interface VerdictInput {
  verdict: AppealVerdict;
  response: string;
  revisedContent?: string;
  revisedRationale?: string;
}

export type VerdictParseResult =
  | { valid: true; data: VerdictInput }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAppealVerdict(value: unknown): value is AppealVerdict {
  return (
    typeof value === "string" &&
    (APPEAL_VERDICTS as readonly string[]).includes(value)
  );
}

/**
 * Validates the `submit_verdict` tool_use input Claude returned. Since the
 * verdict is what drives a DB write (appeal insert, possibly a decision
 * revision), any shape the model didn't produce correctly is treated as a
 * hard failure by the caller (no partial/best-effort recording) — see the
 * ticket's "不正形のフォールバック" requirement.
 */
export function parseVerdictToolInput(input: unknown): VerdictParseResult {
  if (!isRecord(input)) {
    return { valid: false, error: "tool input must be an object" };
  }

  if (!isAppealVerdict(input.verdict)) {
    return {
      valid: false,
      error: `verdict must be one of: ${APPEAL_VERDICTS.join(", ")}`,
    };
  }

  if (typeof input.response !== "string" || input.response.trim() === "") {
    return {
      valid: false,
      error: "response is required and must be a non-empty string",
    };
  }

  if (
    input.revised_content !== undefined &&
    typeof input.revised_content !== "string"
  ) {
    return { valid: false, error: "revised_content must be a string" };
  }

  if (
    input.revised_rationale !== undefined &&
    typeof input.revised_rationale !== "string"
  ) {
    return { valid: false, error: "revised_rationale must be a string" };
  }

  if (
    input.verdict === "revised" &&
    (typeof input.revised_content !== "string" ||
      input.revised_content.trim() === "")
  ) {
    return {
      valid: false,
      error: "revised_content is required when verdict is 'revised'",
    };
  }

  return {
    valid: true,
    data: {
      verdict: input.verdict,
      response: input.response,
      revisedContent: input.revised_content,
      revisedRationale: input.revised_rationale,
    },
  };
}
