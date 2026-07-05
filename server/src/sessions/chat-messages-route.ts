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
import { TASK_TOOLS, executeTaskTool } from "../boss/task-tools.js";
import {
  buildToolResultMessage,
  createClaudeClient,
  streamBossMessage,
} from "../llm/claude-client.js";
import { findSessionById } from "./sessions-repository.js";
import { insertMessage, listMessagesBySessionId } from "./messages-repository.js";
import { validateChatMessageInput } from "./sessions-validation.js";
import type { Message } from "./message.js";

/**
 * Hard cap on the number of Claude round-trips within a single chat turn.
 * Guards against a runaway tool-use loop (explicit assumption, Issue #27):
 * once reached, the turn is finalized with whatever text has been streamed
 * so far — no further Claude call is made.
 */
const MAX_TOOL_ROUNDS = 5;

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

function isToolUseBlock(
  block: Anthropic.ContentBlock,
): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

/**
 * Registers `POST /:id/messages` on the given sessions router. Kept in its
 * own module because the SSE + tool-use orchestration is substantially
 * larger than the other session endpoints in `sessions-routes.ts`.
 */
export function registerChatMessageRoute(
  router: Hono,
  db: Database.Database,
  env: NodeJS.ProcessEnv,
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

    let client: Anthropic;
    try {
      client = createClaudeClient(env);
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
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks,
      recentDecisions,
      now: new Date(),
    });
    const messages = toClaudeMessages(listMessagesBySessionId(db, id));

    return streamSSE(c, async (stream) => {
      try {
        let fullText = "";
        const onTextDelta = (delta: string) => {
          fullText += delta;
          void stream.writeSSE({
            event: "text",
            data: JSON.stringify({ text: delta }),
          });
        };

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const finalMessage = await streamBossMessage(
            client,
            { model, system, messages, tools: TASK_TOOLS },
            onTextDelta,
          );

          const toolUseBlocks = finalMessage.content.filter(isToolUseBlock);
          if (toolUseBlocks.length === 0) {
            break;
          }

          messages.push({
            role: "assistant",
            content:
              finalMessage.content as unknown as Anthropic.MessageParam["content"],
          });

          const toolResultBlocks: Anthropic.MessageParam["content"] = [];
          for (const block of toolUseBlocks) {
            const result = executeTaskTool(db, block.name, block.input);
            await stream.writeSSE({
              event: "tool",
              data: JSON.stringify({
                name: block.name,
                input: block.input,
                result: result.content,
                isError: result.isError,
              }),
            });

            const toolResultMessage = buildToolResultMessage(
              block.id,
              result.content,
              { isError: result.isError },
            );
            if (Array.isArray(toolResultMessage.content)) {
              (toolResultBlocks as unknown[]).push(...toolResultMessage.content);
            }
          }
          messages.push({ role: "user", content: toolResultBlocks });
        }

        const bossMessage = insertMessage(db, {
          session_id: id,
          role: "boss",
          content: fullText,
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
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: GENERIC_STREAM_ERROR_MESSAGE }),
        });
      }
    });
  });
}
