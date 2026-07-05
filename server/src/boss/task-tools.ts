import type Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import { TASK_PRIORITIES, TASK_STATUSES } from "../tasks/task.js";
import { insertTask, updateTask } from "../tasks/tasks-repository.js";
import {
  validateCreateTaskInput,
  validatePatchTaskInput,
} from "../tasks/tasks-validation.js";

/**
 * Tool definitions the boss can invoke during chat (tool use) to operate on
 * tasks directly. Per the ticket's explicit assumption, only create/update
 * are exposed — the current task list is already supplied as chat context,
 * so no "list" tool is needed (YAGNI).
 *
 * `category` is intentionally omitted from both schemas: it is fixed to
 * `work` in the MVP (see `tasks-validation.ts`).
 */
export const TASK_TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description:
      "新しいタスクを作成する。カテゴリは 'work' 固定で自動設定される。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "タスクのタイトル（必須）" },
        description: { type: "string", description: "詳細説明" },
        priority: {
          type: "string",
          enum: [...TASK_PRIORITIES],
          description: "優先度",
        },
        due_at: { type: "string", description: "締切（ISO 8601 日時文字列）" },
        estimated_minutes: {
          type: "integer",
          description: "所要時間見積もり（分）",
        },
        boss_comment: {
          type: "string",
          description: "ボスの決定・コメント",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description:
      "既存タスクを更新する（優先度変更・締切設定・ステータス変更・ボスのコメント付与など）。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "更新対象タスクの id（必須）" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: [...TASK_PRIORITIES] },
        due_at: { type: "string", description: "締切（ISO 8601 日時文字列）" },
        status: { type: "string", enum: [...TASK_STATUSES] },
        boss_comment: { type: "string" },
        estimated_minutes: { type: "integer" },
      },
      required: ["id"],
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function executeCreateTask(
  db: Database.Database,
  input: unknown,
): ToolExecutionResult {
  const result = validateCreateTaskInput(input);
  if (!result.valid) {
    return { content: result.error, isError: true };
  }

  const task = insertTask(db, result.data);
  return { content: JSON.stringify(task), isError: false };
}

function executeUpdateTask(
  db: Database.Database,
  input: unknown,
): ToolExecutionResult {
  if (!isRecord(input) || typeof input.id !== "number") {
    return {
      content: "id is required and must be a number",
      isError: true,
    };
  }

  const result = validatePatchTaskInput(input);
  if (!result.valid) {
    return { content: result.error, isError: true };
  }

  const task = updateTask(db, input.id, result.data);
  if (!task) {
    return { content: `task ${input.id} not found`, isError: true };
  }

  return { content: JSON.stringify(task), isError: false };
}

/**
 * Executes a `tool_use` block against the tasks repository, reusing the
 * existing HTTP-layer validation (status/priority allow-lists etc.) so
 * tool-driven writes are held to the same constraints as `POST /api/tasks`
 * and `PATCH /api/tasks/:id`.
 */
export function executeTaskTool(
  db: Database.Database,
  name: string,
  input: unknown,
): ToolExecutionResult {
  if (name === "create_task") {
    return executeCreateTask(db, input);
  }
  if (name === "update_task") {
    return executeUpdateTask(db, input);
  }
  return { content: `unknown tool: ${name}`, isError: true };
}
