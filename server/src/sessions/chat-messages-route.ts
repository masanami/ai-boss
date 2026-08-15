import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { readJsonBody } from "../lib/read-json-body.js";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { listTasks } from "../tasks/tasks-repository.js";
import { listRecentDecisions } from "../decisions/decisions-repository.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { BOSS_TOOLS, executeBossTool } from "../boss/boss-tools.js";
import type { LlmBackend } from "../config.js";
import {
  createClaudeClient,
  streamBossMessage,
  type BossLlmClient,
  type BossToolExecutor,
} from "../llm/claude-client.js";
import { findSessionById, listRecentSessionSummaries } from "./sessions-repository.js";
import { insertMessage, listMessagesBySessionId } from "./messages-repository.js";
import { validateChatMessageInput } from "./sessions-validation.js";
import type { Message } from "./message.js";

/** Sanitized message surfaced to the client; never includes raw error details
 * (which may contain request internals) per the critical API-key/error
 * handling requirement. */
const GENERIC_STREAM_ERROR_MESSAGE = "ボスの応答中にエラーが発生しました";

function toClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role === "boss" ? "assistant" : "user",
    content: message.content,
  }));
}

/**
 * Human-readable one-liner for a successfully executed task tool, used to
 * build the fallback boss message when a turn produced tool calls but no
 * text (e.g. the tool-round cap was hit). Returns null for failed
 * executions and unparsable results.
 */
function summarizeToolExecution(
  name: string,
  result: { content: string; isError: boolean },
): string | null {
  if (result.isError) {
    return null;
  }
  let title: string | undefined;
  try {
    title = (JSON.parse(result.content) as { title?: string }).title;
  } catch {
    return null;
  }
  if (title === undefined) {
    return null;
  }
  return `タスク「${title}」を${name === "create_task" ? "作成" : "更新"}`;
}

/** Boss message persisted when the stream ended without any text. */
function buildFallbackText(toolSummaries: string[]): string {
  if (toolSummaries.length === 0) {
    return "応答を生成できなかった。もう一度送ってくれ。";
  }
  return `${toolSummaries.join("、")}した。詳細はタスクボードで確認してくれ。`;
}

/**
 * Registers `POST /:id/messages` on the given sessions router. Kept in its
 * own module because the SSE + tool-use orchestration is substantially
 * larger than the other session endpoints in `sessions-routes.ts`.
 *
 * `llmBackend` is threaded down from `loadConfig(env).llmBackend`, with no
 * default here (the default lives at the single `app.ts` boundary — see
 * `CreateAppOptions.llmBackend`'s doc comment).
 */
export function registerChatMessageRoute(
  router: Hono,
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  llmBackend: LlmBackend,
): void {
  router.post("/:id/messages", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    const session = findSessionById(db, id);
    if (!session) {
      return c.json({ error: `session ${rawId} not found` }, 404);
    }

    const body = await readJsonBody(c);
    const validation = validateChatMessageInput(body);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    let client: BossLlmClient;
    try {
      client = createClaudeClient(env, llmBackend);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "failed to initialize the Claude client";
      return c.json({ error: message }, 500);
    }

    insertMessage(db, {
      session_id: id,
      role: "user",
      content: validation.data.content,
    });
    recordActivityEvent(db, { type: "chat_message" });

    const tasks = listTasks(db);
    const recentDecisions = listRecentDecisions(db, 5);
    // Same "5 most recent" convention as recentDecisions above (Issue #96 —
    // 直近の報告履歴の参照). Feeds AC-2: the boss can refer back to recent
    // morning/evening reports without the user re-explaining them.
    const recentSessionSummaries = listRecentSessionSummaries(db, 5);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks,
      recentDecisions,
      recentSessionSummaries,
      now: new Date(),
      sessionType: session.type,
    });
    const messages = toClaudeMessages(listMessagesBySessionId(db, id));

    return streamSSE(c, async (stream) => {
      let fullText = "";
      const toolSummaries: string[] = [];
      try {
        const onTextDelta = (delta: string) => {
          fullText += delta;
          void stream.writeSSE({
            event: "text",
            data: JSON.stringify({ text: delta }),
          });
        };

        const executeTool: BossToolExecutor = (name, input) =>
          executeBossTool(db, id, name, input);

        // The tool loop (MAX_TOOL_ROUNDS · execute · continue) now lives
        // inside streamBossMessage (Issue #78, "ツール実行主体の一本化").
        // This route only relays SSE events from the callbacks it fires.
        //
        // thinking/outputConfig (Issue #117): chat is the one boss-dialogue
        // path where a bit of reasoning genuinely helps ("決める" requires
        // weighing tasks/decisions/history), so it's the only call site that
        // opts back into thinking rather than relying on the facade's
        // fail-safe `disabled` default (`ClaudeMessageRequest.thinking`'s
        // doc comment). `effort: "low"` caps how deep that reasoning goes —
        // chat is interactive (latency matters to the user) and thinking
        // tokens are billed, so the API's own `high` default would be
        // wasteful here. `maxTokens` is left unset (facade default 16000),
        // which is sized for `effort: "low"` thinking plus a full reply.
        await streamBossMessage(
          client,
          {
            model,
            system,
            messages,
            tools: BOSS_TOOLS,
            thinking: { type: "adaptive" },
            outputConfig: { effort: "low" },
          },
          {
            onTextDelta,
            executeTool,
            onToolEvent: async (event) => {
              const summary = summarizeToolExecution(event.name, {
                content: event.result,
                isError: event.isError,
              });
              if (summary !== null) {
                toolSummaries.push(summary);
              }
              await stream.writeSSE({
                event: "tool",
                data: JSON.stringify({
                  name: event.name,
                  input: event.input,
                  result: event.result,
                  isError: event.isError,
                }),
              });
            },
          },
        );

        const bossMessage = insertMessage(db, {
          session_id: id,
          role: "boss",
          content: fullText !== "" ? fullText : buildFallbackText(toolSummaries),
        });
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify(bossMessage),
        });
      } catch (err) {
        // Only log the error's class name, never its message: Claude API
        // errors may embed request details (or, in principle, request
        // headers) in `message`, and this is a critical path where those
        // must not reach logs (docs/features/ai-boss-mvp.md クリティカル
        // 設計決定 > 外部システム連携）。
        console.error(
          "chat message stream failed:",
          err instanceof Error ? err.name : typeof err,
        );
        // Text already streamed to the client is part of the conversation
        // the user actually saw — persist it so the history stays consistent
        // after a reload instead of silently dropping the partial reply.
        if (fullText !== "") {
          try {
            insertMessage(db, { session_id: id, role: "boss", content: fullText });
          } catch (persistErr) {
            console.error(
              "failed to persist the partial boss message:",
              persistErr instanceof Error ? persistErr.name : typeof persistErr,
            );
          }
        }
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: GENERIC_STREAM_ERROR_MESSAGE }),
        });
      }
    });
  });
}
