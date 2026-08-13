import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BossContentBlock,
  BossLlmMessage,
  BossToolExecutor,
  OnTextDelta,
  OnToolEvent,
} from "../claude-client.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../tasks/task.js";
import { APPEAL_VERDICTS } from "../../decisions/appeal.js";

/**
 * `claude-code` backend (Issue #79): calls the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`, which drives a local Claude Code
 * execution environment authenticated via the owner's subscription login)
 * instead of the Claude API directly.
 *
 * クリティカル設計決定（docs/features/claude-code-backend.md）:
 * - カスタムツールは in-process MCP サーバ（`createSdkMcpServer` / `tool()`）
 *   として提供する。既存の JSON Schema（`boss-tools.ts` / `task-tools.ts` /
 *   `verdict-tool.ts`）は単一ソースとして変更しない。Zod スキーマはこの
 *   ファイル内に閉じて手書きし、整合はユニットテストで担保する
 *   （`TOOL_ZOD_SHAPES` を参照）。
 * - 「補足決定（ツール実行主体の一本化）」: DB に書き込む実行系ツール
 *   （`create_task` / `update_task` / `record_decision`）は MCP ハンドラが
 *   実行主体となり、`callbacks.executeTool`（呼び出し元が db/sessionId を
 *   クロージャで束縛済み）をハンドラ内から一度だけ呼ぶ。呼び出し元
 *   （`claude-client.ts`）はこの結果を tool_use として再実行しない
 *   （`streamBossMessage` は claude-code バックエンド時、単一 dispatch のみ
 *   行い MAX_TOOL_ROUNDS ループを回さない — 詳細は `claude-client.ts`）。
 * - `submit_verdict` はツール実行関数を持たない（DB 書き込みは呼び出し元の
 *   `appeals-route.ts` がトランザクションで行う）。MCP ハンドラは入力を
 *   捕捉して受理応答を返すのみで、検証（`parseVerdictToolInput`）は既存の
 *   `requestVerdict`（`claude-client.ts`）が返り値の tool_use ブロックに
 *   対して行う — API バックエンドと同じ経路を通すことで検証ロジックの
 *   重複を避ける。
 */

const MCP_SERVER_NAME = "ai-boss";
const MCP_TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function mcpToolName(name: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${name}`;
}

/**
 * The model calls in-process MCP tools by their fully-qualified name
 * (`mcp__<server>__<tool>` — see `mcpToolName`/`allowedTools` above and
 * `sdk.d.ts`'s `disallowedTools`/`mcp_call` doc comments for the same
 * qualification scheme), so `SDKAssistantMessage`'s `tool_use` blocks carry
 * that qualified name too. Strip it back to the bare name our own callers
 * use (`requestVerdict`'s `toolName` match, `executeBossTool`'s dispatch)
 * before surfacing a `tool_use` block in the normalized `BossLlmMessage` —
 * self-review caught this: without stripping, claude-code re-adjudication
 * would never match `toolName === "submit_verdict"` and always resolve to
 * `{called: false}` (HTTP 500), since `requestVerdict` compares against the
 * bare name.
 */
function unqualifyToolName(name: string): string {
  return name.startsWith(MCP_TOOL_NAME_PREFIX) ? name.slice(MCP_TOOL_NAME_PREFIX.length) : name;
}

// ---------------------------------------------------------------------------
// Zod スキーマ（既存 JSON Schema の手書き対応。整合はテストで担保 — 変換
// ライブラリは追加しない、というクリティカル設計決定に従う）
// ---------------------------------------------------------------------------

const createTaskShape = {
  title: z.string().describe("タスクのタイトル（必須）"),
  description: z.string().describe("詳細説明").optional(),
  priority: z.enum(TASK_PRIORITIES).describe("優先度").optional(),
  due_at: z.string().describe("締切（ISO 8601 日時文字列）").optional(),
  estimated_minutes: z.number().int().describe("所要時間見積もり（分）").optional(),
  boss_comment: z.string().describe("ボスの決定・コメント").optional(),
};

const updateTaskShape = {
  id: z.number().int().describe("更新対象タスクの id（必須）"),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  due_at: z.string().describe("締切（ISO 8601 日時文字列）").optional(),
  status: z.enum(TASK_STATUSES).optional(),
  boss_comment: z.string().optional(),
  estimated_minutes: z.number().int().optional(),
};

const recordDecisionShape = {
  content: z.string().describe("決定内容（必須）"),
  rationale: z.string().describe("決定の根拠").optional(),
  task_id: z.number().int().describe("関連するタスクの id").optional(),
};

const submitVerdictShape = {
  verdict: z.enum(APPEAL_VERDICTS).describe("裁定結果。維持なら upheld、修正するなら revised。"),
  response: z.string().describe("ボスの再裁定文（ユーザーに提示する説明・断言）"),
  revised_content: z.string().describe("verdict が revised の場合の修正後の決定内容（必須）").optional(),
  revised_rationale: z.string().describe("修正の根拠").optional(),
};

/**
 * Exported so a unit test can assert the Zod shapes' keys/required-ness stay
 * aligned with the JSON Schema tool definitions (`BOSS_TOOLS`,
 * `SUBMIT_VERDICT_TOOL`) that remain the single source of truth.
 */
export const TOOL_ZOD_SHAPES = {
  create_task: createTaskShape,
  update_task: updateTaskShape,
  record_decision: recordDecisionShape,
  submit_verdict: submitVerdictShape,
} as const;

/** Derived from `TOOL_ZOD_SHAPES` (minus `submit_verdict`, which has its own
 * non-executing handler — see `buildSubmitVerdictTool`) rather than a
 * separately hand-maintained literal list, so there is a single place to add
 * a new DB-writing tool (self-review: avoid triple bookkeeping across
 * `BOSS_TOOLS`, `TOOL_ZOD_SHAPES`, and this set). */
const EXECUTED_TOOL_NAMES = new Set(
  Object.keys(TOOL_ZOD_SHAPES).filter((name) => name !== "submit_verdict"),
);

// ---------------------------------------------------------------------------
// プロンプト構築（ステートレス方式: DB から再構築した履歴を毎回全文送信する
// という補足決定を、Agent SDK の単一 prompt 文字列インターフェースの上で
// 実現する。単一ユーザーターンのみの場合はそのままテキストを渡し、複数
// ターンの場合はロール付きの平文トランスクリプトに整形する。会話履歴には
// tool_use/tool_result ブロックは含まれない — ルートから渡される
// `request.messages` は DB 由来のプレーンテキスト往復のみで、途中経過の
// ツール呼び出しは MCP ハンドラ内で完結し履歴化されないため）。
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = { user: "User", assistant: "Boss" };

function extractMessageText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => ("text" in block && block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

export function buildClaudeCodePrompt(messages: Anthropic.MessageParam[]): string {
  if (messages.length === 0) {
    return "";
  }
  if (messages.length === 1 && messages[0].role === "user") {
    return extractMessageText(messages[0].content);
  }
  return messages
    .map((message) => `${ROLE_LABELS[message.role] ?? message.role}: ${extractMessageText(message.content)}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// in-process MCP サーバ構築
// ---------------------------------------------------------------------------

interface McpHooks {
  executeTool?: BossToolExecutor;
  onToolEvent?: OnToolEvent;
}

class ClaudeCodeBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeBackendError";
  }
}

function buildExecutedTool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, hooks: McpHooks) {
  return tool(name, description, shape, async (args) => {
    if (!hooks.executeTool) {
      throw new ClaudeCodeBackendError(
        `claude-code backend: tool "${name}" was called but no executeTool callback was supplied`,
      );
    }
    const result = await hooks.executeTool(name, args);
    if (hooks.onToolEvent) {
      await hooks.onToolEvent({ name, input: args, result: result.content, isError: result.isError });
    }
    return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
  });
}

/**
 * `submit_verdict` has no execution function of its own — the DB write
 * happens in the caller (`appeals-route.ts`'s transaction) after
 * `requestVerdict` resolves, and validation (`parseVerdictToolInput`) is
 * performed by `requestVerdict` itself against the `tool_use` block that
 * naturally appears in the model's assistant message (captured by
 * `runClaudeCodeQuery`'s message loop below — same as the `api` backend,
 * which never executes this tool either). This handler's only job is to
 * satisfy the MCP round-trip the SDK requires to complete the turn.
 */
function buildSubmitVerdictTool(description: string) {
  return tool("submit_verdict", description, submitVerdictShape, async () => {
    return { content: [{ type: "text" as const, text: "裁定を受け付けた。" }] };
  });
}

/** Builds the in-process MCP server exposing exactly the tools named in
 * `tools` (the JSON Schema `Anthropic.Tool[]` the facade forwards — for
 * chat this is `BOSS_TOOLS`, for re-adjudication `[SUBMIT_VERDICT_TOOL]`,
 * for dashboard-comment/notification-body it is empty/undefined). Throws if
 * a tool name has no registered Zod schema — a defensive guard, since the
 * call sites are all controlled by this codebase. */
function buildMcpServer(toolDefs: Anthropic.Tool[], hooks: McpHooks) {
  const tools = toolDefs.map((toolDef) => {
    if (toolDef.name === "submit_verdict") {
      return buildSubmitVerdictTool(toolDef.description ?? "");
    }
    if (EXECUTED_TOOL_NAMES.has(toolDef.name)) {
      const shape = TOOL_ZOD_SHAPES[toolDef.name as keyof typeof TOOL_ZOD_SHAPES];
      return buildExecutedTool(toolDef.name, toolDef.description ?? "", shape, hooks);
    }
    throw new ClaudeCodeBackendError(
      `claude-code backend: no Zod schema registered for tool "${toolDef.name}"`,
    );
  });
  return createSdkMcpServer({ name: MCP_SERVER_NAME, tools });
}

/**
 * Runaway-loop guard (self-review): the `claude-code` backend runs Agent
 * SDK's own internal multi-turn tool loop instead of the facade's
 * `MAX_TOOL_ROUNDS` (see `claude-client.ts`'s `streamBossMessage` doc
 * comment), and without a cap here a misbehaving turn could keep calling
 * DB-writing tools until the 120s facade timeout — burning subscription
 * usage and, per the non-functional requirement "信頼性" (3), each such
 * call is itself never retried once it has a side effect, so a long unbounded
 * loop has no other backstop. `maxTurns` is *not* used as a substitute for
 * the timeout (docs/features/claude-code-backend.md 非機能要件・信頼性 (2)
 * explicitly reserves that role for `AbortController`) — it is a
 * defense-in-depth cap set generously above the `api` backend's
 * `MAX_TOOL_ROUNDS` (5) to account for the Agent SDK counting turns
 * differently (a single tool round-trip may span more than one internal
 * "turn").
 */
const MAX_AGENT_TURNS = 10;

// ---------------------------------------------------------------------------
// クエリ実行
// ---------------------------------------------------------------------------

export interface ClaudeCodeMessageRequest {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  /** JSON Schema tool definitions from the facade (`BOSS_TOOLS` /
   * `[SUBMIT_VERDICT_TOOL]` / undefined). Only used to decide which
   * in-process MCP tools to register — `maxTokens`/`toolChoice` have no
   * Agent SDK equivalent and are intentionally not forwarded (see the
   * feature spec's 前提・仮定 3). */
  tools?: Anthropic.Tool[];
}

export interface ClaudeCodeDispatchOptions {
  onTextDelta?: OnTextDelta;
  onToolEvent?: OnToolEvent;
  executeTool?: BossToolExecutor;
  /** Shared deadline signal (AC-11) — a fresh `AbortController` is created
   * per attempt and wired to abort when this signal aborts, since the Agent
   * SDK's `query()` takes an `AbortController`, not a raw `AbortSignal`. */
  signal?: AbortSignal;
}

/**
 * Runs a single Agent SDK `query()` call to completion and normalizes it to
 * a `BossLlmMessage` (FR-04's content-block contract). Shared by the
 * streaming (chat) and non-streaming (verdict / dashboard comment /
 * notification body) call sites — the only behavioral difference is whether
 * `includePartialMessages` is requested and `onTextDelta` is wired.
 */
async function runClaudeCodeQuery(
  request: ClaudeCodeMessageRequest,
  options: ClaudeCodeDispatchOptions,
): Promise<BossLlmMessage> {
  const toolDefs = request.tools ?? [];
  const mcpServer =
    toolDefs.length > 0
      ? buildMcpServer(toolDefs, {
          executeTool: options.executeTool,
          onToolEvent: options.onToolEvent,
        })
      : undefined;
  const allowedTools = toolDefs.map((toolDef) => mcpToolName(toolDef.name));

  const abortController = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) {
      abortController.abort();
    } else {
      options.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const stream = query({
    prompt: buildClaudeCodePrompt(request.messages),
    options: {
      model: request.model,
      systemPrompt: request.system,
      abortController,
      // FR-06 (multi-layer built-in tool disablement):
      // 1. `tools: []` — explicit built-in tool set, empty = all disabled.
      // 2. `settingSources: []` — do not load settings-file-declared tools/MCP.
      // 3. `strictMcpConfig: true` — only the `mcpServers` passed here (no
      //    project/user/plugin MCP).
      // 4. `allowedTools` — auto-approve only our own MCP tools (does not by
      //    itself restrict availability; combined with 1-3 above per the
      //    ticket's explicit instruction not to rely on the allow-list alone).
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      mcpServers: mcpServer ? { [MCP_SERVER_NAME]: mcpServer } : undefined,
      includePartialMessages: Boolean(options.onTextDelta),
      maxTurns: MAX_AGENT_TURNS,
    },
  });

  const content: BossContentBlock[] = [];
  let sawSuccessResult = false;
  let textDeltaRelayed = false;

  for await (const message of stream) {
    if (message.type === "stream_event") {
      const { event } = message;
      if (
        options.onTextDelta &&
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        options.onTextDelta(event.delta.text);
        textDeltaRelayed = true;
      }
      continue;
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: unqualifyToolName(block.name),
            input: block.input,
          });
        }
      }
      continue;
    }
    if (message.type === "result") {
      // 補足決定「FR-10 とエラーハンドリングの整合」: Agent SDK が例外では
      // なく非成功の結果メッセージ（is_error 相当）を返す経路もすべて
      // Error へ変換し、不完全な応答を成功として返さない。
      if (message.subtype !== "success") {
        throw new ClaudeCodeBackendError(
          `claude-code backend query did not complete successfully (${message.subtype})`,
        );
      }
      sawSuccessResult = true;
    }
  }

  if (!sawSuccessResult) {
    throw new ClaudeCodeBackendError("claude-code backend query ended without a result message");
  }

  // FR-04 / non-functional requirement "パフォーマンス" 縮退仕様: partial
  // message streaming was requested (`includePartialMessages`) but no
  // `content_block_delta`/`text_delta` ever arrived — e.g. the running SDK
  // version doesn't actually emit them despite the option, or the reply
  // came through a message shape this loop doesn't treat as a delta source.
  // Without this fallback the assistant's text would sit unused in `content`
  // forever, since callers that stream (`chat-messages-route.ts`) build their
  // persisted message purely from `onTextDelta` accumulation and never read
  // this function's return value (self-review caught this — see the ticket's
  // 前提・仮定 4: "取得できない場合はメッセージ単位の送出（delta なし・1
  // 応答 1 text イベント）へ縮退し、その旨を実装チケットに記録する").
  if (options.onTextDelta && !textDeltaRelayed) {
    const fullText = content
      .filter((block): block is Extract<BossContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (fullText !== "") {
      options.onTextDelta(fullText);
    }
  }

  return { content };
}

export function streamClaudeCodeMessage(
  request: ClaudeCodeMessageRequest,
  options: ClaudeCodeDispatchOptions = {},
): Promise<BossLlmMessage> {
  return runClaudeCodeQuery(request, options);
}

export function createClaudeCodeMessage(
  request: ClaudeCodeMessageRequest,
  options: Pick<ClaudeCodeDispatchOptions, "signal"> = {},
): Promise<BossLlmMessage> {
  return runClaudeCodeQuery(request, options);
}
