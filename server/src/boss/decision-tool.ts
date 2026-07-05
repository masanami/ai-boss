import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { insertDecision } from "../decisions/decisions-repository.js";
import { findTaskById } from "../tasks/tasks-repository.js";
import type { ToolExecutionResult } from "./task-tools.js";

/**
 * Tool the boss invokes during chat to record a decision it has just made
 * (priority calls, quota/deadline rulings, carry-overs, etc. — see the
 * ticket's completion criteria). Recording is LLM-driven: the server does
 * not infer decisions from free text, it only persists what the tool call
 * says (explicit assumption, Issue #46).
 */
export const RECORD_DECISION_TOOL: Anthropic.Tool = {
  name: "record_decision",
  description:
    "重要な決定（優先順位・ノルマ・締切・持ち越し等の裁定）を下したときに呼び、決定内容を決定ログへ記録する。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "決定内容（必須）" },
      rationale: { type: "string", description: "決定の根拠" },
      task_id: { type: "integer", description: "関連するタスクの id" },
    },
    required: ["content"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Executes a `record_decision` tool_use block against the decisions
 * repository. `sessionId` comes from the chat route (the tool has no way to
 * know its own session otherwise) and is not part of the LLM-provided
 * input.
 */
export function executeRecordDecisionTool(
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
  });

  return { content: JSON.stringify(decision), isError: false };
}
