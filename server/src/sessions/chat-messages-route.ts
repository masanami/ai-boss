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

/**
 * Maps stored messages to the Anthropic `MessageParam` shape, then drops any
 * leading `assistant` entries (Issue #271 — 機能仕様
 * docs/features/meeting-start-announcement.md「実装時に必ず対処する波及点」).
 *
 * A meeting-opening line (`role: "boss"`, `meeting-opening.ts`) is persisted
 * with the oldest `created_at` in its session, so once one exists the
 * conversation's first message is `role: "boss"` -> normalized to
 * `"assistant"`. The Anthropic Messages API rejects a request whose first
 * message isn't `role: "user"` ("First message must be `user`"). The
 * `claude-code` backend never sees this (its `buildClaudeCodePrompt` flattens
 * the history into a plain transcript instead), so this bug is invisible on
 * the default backend and only reachable with `LLM_BACKEND=api` — the
 * regression test on this function's caller side is the only guard against
 * it silently coming back.
 *
 * Drops every *leading* `assistant` entry (not just one), rather than
 * assuming exactly one meeting-opening message can appear: correct even if
 * that assumption ever changes, and a no-op whenever the first message is
 * already `user` (the common case today).
 */
function toClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  const normalized: Anthropic.MessageParam[] = messages.map((message) => ({
    role: message.role === "boss" ? "assistant" : "user",
    content: message.content,
  }));

  let start = 0;
  while (start < normalized.length && normalized[start].role === "assistant") {
    start += 1;
  }
  return normalized.slice(start);
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

    // The client stopping the generation *is* the client hanging up: there is
    // no stop endpoint, just an aborted `fetch` (#254 論点2). On Node, an
    // aborted request reaches us as `c.req.raw.signal` — `@hono/node-server`
    // aborts it from its response-close handler ("Client connection
    // prematurely closed."). Handing that same signal to `streamBossMessage`
    // is what actually stops the LLM call instead of leaving it running to
    // completion.
    //
    // `c.req.raw.signal` rather than `stream.onAbort()` (both fire here) —
    // it is already an `AbortSignal`, so it needs no adapter, and it is the
    // same value the catch block below reads to tell a user-initiated stop
    // apart from a genuine failure.
    const requestSignal = c.req.raw.signal;

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
        // wasteful here (`effort` bounds the whole turn's elaborateness, not
        // just thinking depth — see `ClaudeMessageRequest.outputConfig`).
        // `maxTokens` is left unset (facade default 16000), which is sized
        // for `effort: "low"` thinking plus a full reply.
        //
        // This is also the only call site that runs the facade's tool loop
        // *and* enables thinking, which is why that loop replays the
        // assistant turn from `BossLlmMessage.rawContent` (thinking block
        // and signature intact) rather than the normalized content.
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
          { signal: requestSignal },
        );

        // Reaching here means the generation completed, so this reply is
        // whole — even if the client hung up in the same tick that the last
        // chunk landed. 完了が勝つ (#254 論点5): marking a fully generated
        // reply "interrupted" because a stop arrived a moment too late would
        // state something untrue about the text we are storing.
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
        // Distinguishing a user-initiated stop from a genuine failure is the
        // one thing the abort signal is read for here (#254 論点4): the LLM
        // facade deliberately surfaces an external abort as its existing
        // timeout error rather than a new error type, so the error alone
        // cannot tell the two apart — the signal can.
        const stoppedByUser = requestSignal.aborted;

        if (stoppedByUser) {
          // Not a failure: the user asked for this. Logged (without any error
          // detail) so an operator reading the log can still tell why a reply
          // in the history ends mid-sentence.
          console.info("chat message stream stopped by the client");
        } else {
          // Only log the error's class name, never its message: Claude API
          // errors may embed request details (or, in principle, request
          // headers) in `message`, and this is a critical path where those
          // must not reach logs（docs/adr/0002-api-key-and-llm-call-path.md
          // 決定 4: 失敗時のログに残すのはエラークラス名まで）。
          console.error(
            "chat message stream failed:",
            err instanceof Error ? err.name : typeof err,
          );
        }
        // Text already streamed to the client is part of the conversation
        // the user actually saw — persist it so the history stays consistent
        // after a reload instead of silently dropping the partial reply
        // （配信済みテキストが無ければ永続化せず、途中まで
        // 配信されていればその部分テキストを永続化する）。
        //
        // `interrupted: true` on **both** paths (#254 論点1・決定 1-b): the
        // column says "this reply ended early", not "the user stopped it".
        // A reply cut short by a failed or timed-out LLM call is just as
        // incomplete as one the user stopped, and the reader wants the same
        // thing signalled in both cases — that the text stops mid-thought.
        if (fullText !== "") {
          try {
            insertMessage(db, {
              session_id: id,
              role: "boss",
              content: fullText,
              interrupted: true,
            });
          } catch (persistErr) {
            console.error(
              "failed to persist the partial boss message:",
              persistErr instanceof Error ? persistErr.name : typeof persistErr,
            );
          }
        }
        if (!stoppedByUser) {
          // A stop is not an error, so no error event is reported for it.
          // (The write would be swallowed anyway — the socket is already
          // gone — but sending one would misrepresent what happened to any
          // client that did still read it.)
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: GENERIC_STREAM_ERROR_MESSAGE }),
          });
        }
      }
    });
  });
}
