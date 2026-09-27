import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db/db-port.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../tasks/task.js";
import { createTask, updateTask } from "../tasks/tasks-repository.js";
import {
  COMMITMENT_REQUIRES_TODO_ERROR,
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
        // due_at はローカル暦日（ADR 0010 決定 1）。「その日の何時まで」を表現
        // する手段は持たない。実測（ADR 0010 背景）では、ここが「ISO 8601 日時
        // 文字列」だったために LLM が就業終わりの T18:00:00+09:00 を自分で補って
        // いた。書き手が LLM である以上、求める形は説明文で明示する必要がある。
        //
        // claude-code-backend.ts の Zod shape と同じ文言を**あえて二重に**書く。
        // 同ファイルのテストが両者の description 一致を検証しており、定数を共有
        // するとその検証が恒真になるため（片方だけ変えたときに落ちる形を保つ）。
        due_at: { type: "string", description: '締切（ローカル暦日 "YYYY-MM-DD"）' },
        estimated_minutes: {
          type: "integer",
          description: "所要時間見積もり（分）",
        },
        boss_comment: {
          type: "string",
          description: "ボスの決定・コメント",
        },
        evidence_required: {
          type: "boolean",
          description:
            "完了報告にエビデンス（ファイル添付・リンク）を必須にするか。省略時は false。",
        },
        // 着手の約束（機能仕様 docs/features/task-start-commitment.md 決定6）。
        // 作成時は値のみ受け付ける（取り消す約束が無いため null は扱わない）。
        //
        // claude-code-backend.ts の Zod shape と同じ文言を**あえて二重に**書く
        // （due_at と同じ作法。上のコメント参照。同ファイルのテストが description
        // 一致を検証しており、定数を共有するとその検証が恒真になるため）。
        committed_start_at: {
          type: "string",
          description:
            '着手の約束（時刻とオフセットを含む ISO 8601 の日時。例: "2026-09-14T20:00:00+09:00"）。' +
            "ユーザーが確認した着手日時のみを設定すること。",
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
        due_at: { type: "string", description: '締切（ローカル暦日 "YYYY-MM-DD"）' },
        status: { type: "string", enum: [...TASK_STATUSES] },
        boss_comment: { type: "string" },
        estimated_minutes: { type: "integer" },
        // 着手の約束（決定6）。null は「取り消す」— 約束の編集 UI が無いため、
        // ボスの update_task がオーナーの取り消し要求を反映できる唯一の経路
        // （claude-code-backend.ts の Zod shape も同じく nullable にする必要が
        // ある。片方だけが null を弾くと、そのバックエンドでは取り消せなくなる）。
        committed_start_at: {
          type: ["string", "null"],
          description:
            '着手の約束（時刻とオフセットを含む ISO 8601 の日時。例: "2026-09-14T20:00:00+09:00"）。' +
            "ユーザーが確認した着手日時のみを設定すること。null を指定すると約束を取り消す。",
        },
      },
      required: ["id"],
    },
  },
];

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

// 決定 2-e: ボスチャット経由の拒否は既存のエラー返却様式で理由文字列を
// 返すだけでよい（専用の仕組みを足さない）。ツール結果は会話へ戻るため、
// この文言をボスがそのままユーザーへ伝える形になる。create_task・update_task
// の両方の関門拒否で使う。
const EVIDENCE_REQUIRED_TOOL_ERROR =
  "エビデンスが添付されていないため、このタスクを完了にできません。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function executeCreateTask(
  db: Db,
  input: unknown,
): Promise<ToolExecutionResult> {
  const result = validateCreateTaskInput(input);
  if (!result.valid) {
    return { content: result.error, isError: true };
  }

  // 決定 2-h / Issue #619: POST /api/tasks と同じ関門（同じトランザクション
  // 内の判定）を通す。拒否の文言は update_task の関門拒否と同じにする。
  const createResult = await createTask(db, result.data);
  if (!createResult.ok) {
    return { content: EVIDENCE_REQUIRED_TOOL_ERROR, isError: true };
  }
  return { content: JSON.stringify(createResult.task), isError: false };
}

async function executeUpdateTask(
  db: Db,
  input: unknown,
): Promise<ToolExecutionResult> {
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

  const updateResult = await updateTask(db, input.id, result.data);
  if (!updateResult.ok) {
    if (updateResult.reason === "not_found") {
      return { content: `task ${input.id} not found`, isError: true };
    }
    if (updateResult.reason === "commitment_requires_todo") {
      // 決定3-2（Issue #527）: ボスがツール結果を見て言い直せるよう、理由の
      // 文言を isError: true で返す。
      return {
        content: `${COMMITMENT_REQUIRES_TODO_ERROR}。`,
        isError: true,
      };
    }
    return { content: EVIDENCE_REQUIRED_TOOL_ERROR, isError: true };
  }

  return { content: JSON.stringify(updateResult.task), isError: false };
}

/**
 * Executes a `tool_use` block against the tasks repository, reusing the
 * existing HTTP-layer validation (status/priority allow-lists etc.) so
 * tool-driven writes are held to the same constraints as `POST /api/tasks`
 * and `PATCH /api/tasks/:id`.
 */
export async function executeTaskTool(
  db: Db,
  name: string,
  input: unknown,
): Promise<ToolExecutionResult> {
  if (name === "create_task") {
    return executeCreateTask(db, input);
  }
  if (name === "update_task") {
    return executeUpdateTask(db, input);
  }
  return { content: `unknown tool: ${name}`, isError: true };
}
