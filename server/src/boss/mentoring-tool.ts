import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { insertDecision } from "../decisions/decisions-repository.js";
import { findTaskById } from "../tasks/tasks-repository.js";
import type { ToolExecutionResult } from "./task-tools.js";

/**
 * Tool the boss invokes to record the conclusion of a work-approach
 * mentoring check (#276 判断 4・5). Kept separate from `record_decision`
 * (rather than adding a `kind` argument to it) so the caller cannot
 * mistake an ordinary ruling for a mentoring conclusion or vice versa —
 * the prompt's mentoring step and this tool are 1:1, and the mentoring
 * completion gate (`mentoring-gate.ts`) depends on `kind` being correct.
 *
 * `content` holds the conclusion (what changes / doesn't change about the
 * approach); `rationale` holds the concern(s) the boss judged as risky —
 * i.e. the observations handled during the check. This mirrors the
 * feature spec's "content = conclusion, rationale = observations handled"
 * mapping (docs/features/work-approach-mentoring.md 判断5).
 */
export const RECORD_MENTORING_TOOL: Anthropic.Tool = {
  name: "record_mentoring",
  description:
    "仕事の進め方の点検（メンタリング）の結論を下したときに呼び、結論を決定ログへ記録する。content には結論を、rationale には扱った観点（何を危ういと判断したか）を書く。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "点検の結論（必須）" },
      rationale: { type: "string", description: "扱った観点（どの点をどう危ういと判断したか）" },
      task_id: { type: "integer", description: "関連するタスクの id" },
    },
    required: ["content"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Executes a `record_mentoring` tool_use block against the decisions
 * repository, always writing `kind: 'mentoring'`. `sessionId` comes from
 * the chat route (the tool has no way to know its own session otherwise)
 * and is not part of the LLM-provided input. Input validation mirrors
 * `executeRecordDecisionTool` exactly (shared shape, different `kind`).
 */
export function executeRecordMentoringTool(
  db: Database.Database,
  sessionId: number,
  input: unknown,
): ToolExecutionResult {
  if (!isRecord(input) || typeof input.content !== "string" || input.content.trim() === "") {
    return {
      content: "content is required and must be a non-empty string",
      isError: true,
    };
  }

  if (input.task_id !== undefined && input.task_id !== null) {
    if (typeof input.task_id !== "number") {
      return { content: "task_id must be a number or null", isError: true };
    }
    if (!findTaskById(db, input.task_id)) {
      return { content: `task ${input.task_id} not found`, isError: true };
    }
  }

  if (input.rationale !== undefined && typeof input.rationale !== "string") {
    return { content: "rationale must be a string", isError: true };
  }

  const decision = insertDecision(db, {
    session_id: sessionId,
    content: input.content,
    task_id: (input.task_id as number | undefined) ?? null,
    rationale: (input.rationale as string | undefined) ?? null,
    kind: "mentoring",
  });

  return { content: JSON.stringify(decision), isError: false };
}
