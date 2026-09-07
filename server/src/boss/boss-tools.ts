import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { TASK_TOOLS, executeTaskTool, type ToolExecutionResult } from "./task-tools.js";
import { RECORD_DECISION_TOOL, executeRecordDecisionTool } from "./decision-tool.js";
import { RECORD_MENTORING_TOOL, executeRecordMentoringTool } from "./mentoring-tool.js";
import { GET_ACTIVITY_LOG_TOOL, executeGetActivityLogTool } from "./activity-log-tool.js";

/**
 * All tools exposed to the boss during chat tool use: the existing task
 * tools plus `record_decision` (Issue #46), `record_mentoring` (Issue
 * #276/#407 — always included, regardless of session type or the
 * mentoring-required setting; whether mentoring instructions are actually
 * pushed into the prompt is the caller's responsibility), and
 * `get_activity_log` (Issue #150). Kept as a thin composition layer so
 * `task-tools.ts`'s own signature/tests stay untouched — only the chat
 * route needs the session-aware dispatch added here.
 */
export const BOSS_TOOLS: Anthropic.Tool[] = [
  ...TASK_TOOLS,
  RECORD_DECISION_TOOL,
  RECORD_MENTORING_TOOL,
  GET_ACTIVITY_LOG_TOOL,
];

/**
 * Dispatches a `tool_use` block to the right executor. `record_decision`
 * and `record_mentoring` need the current chat session's id (to satisfy
 * `decisions.session_id NOT NULL`), which the LLM cannot supply itself, so
 * it is threaded through explicitly by the caller (the chat message route)
 * rather than exposed as an input field. `get_activity_log` is a pure DB
 * read with no session dependency, so it is dispatched directly without
 * `sessionId`.
 */
export function executeBossTool(
  db: Database.Database,
  sessionId: number,
  name: string,
  input: unknown,
): ToolExecutionResult {
  if (name === "record_decision") {
    return executeRecordDecisionTool(db, sessionId, input);
  }
  if (name === "record_mentoring") {
    return executeRecordMentoringTool(db, sessionId, input);
  }
  if (name === "get_activity_log") {
    return executeGetActivityLogTool(db, input);
  }
  return executeTaskTool(db, name, input);
}
