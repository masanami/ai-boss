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
 *
 * `mentoringTaskId` (Issue #469 / task-scoped-mentoring 決定5) is the task
 * the caller is mentoring about for this turn — supplied the same way as
 * `sessionId` (the LLM cannot know it). When the boss calls `record_mentoring`
 * without `task_id` (undefined or explicit `null` — the two are already
 * treated as equivalent below), `mentoringTaskId` is used as the value to
 * persist and is subject to the same `findTaskById` existence check as an
 * explicit `task_id`. An explicit non-null `task_id` from the boss always
 * wins over `mentoringTaskId` (fallback never overwrites it).
 */
export function executeRecordMentoringTool(
  db: Database.Database,
  sessionId: number,
  input: unknown,
  mentoringTaskId?: number,
): ToolExecutionResult {
  if (!isRecord(input) || typeof input.content !== "string" || input.content.trim() === "") {
    return {
      content: "content is required and must be a non-empty string",
      isError: true,
    };
  }

  if (input.task_id !== undefined && input.task_id !== null && typeof input.task_id !== "number") {
    return { content: "task_id must be a number or null", isError: true };
  }

  const explicitTaskId = typeof input.task_id === "number" ? input.task_id : undefined;
  const effectiveTaskId = explicitTaskId ?? mentoringTaskId ?? null;

  if (effectiveTaskId !== null && !findTaskById(db, effectiveTaskId)) {
    return { content: `task ${effectiveTaskId} not found`, isError: true };
  }

  if (input.rationale !== undefined && typeof input.rationale !== "string") {
    return { content: "rationale must be a string", isError: true };
  }

  const decision = insertDecision(db, {
    session_id: sessionId,
    content: input.content,
    task_id: effectiveTaskId,
    rationale: (input.rationale as string | undefined) ?? null,
    kind: "mentoring",
  });

  return { content: JSON.stringify(decision), isError: false };
}
