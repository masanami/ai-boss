import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { readJsonBody } from "../lib/read-json-body.js";
import { stripHtmlTags, splitPendingTagTail } from "../lib/strip-html-tags.js";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { listTasks } from "../tasks/tasks-repository.js";
import { countTaskEvidencesByTaskIds } from "../tasks/task-evidences-repository.js";
import { listRecentDecisions } from "../decisions/decisions-repository.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { resolveMorningMentoringRequired } from "../settings/mentoring-settings.js";
import {
  buildPersonaPrompt,
  type TodaysAdhocMessage,
} from "../boss/persona-prompt.js";
import { BOSS_TOOLS, executeBossTool } from "../boss/boss-tools.js";
import type { LlmBackend } from "../config.js";
import {
  createClaudeClient,
  streamBossMessage,
  type BossLlmClient,
  type BossToolExecutor,
} from "../llm/claude-client.js";
import { findSessionById, listRecentSessionSummaries } from "./sessions-repository.js";
import {
  deleteMessagesFrom,
  findMessageInSession,
  insertMessage,
  listMessagesBySessionId,
  listTodaysAdhocMessages,
} from "./messages-repository.js";
import { validateChatMessageInput } from "./sessions-validation.js";
import type { Message } from "./message.js";
import type { SessionType } from "./session.js";

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
 * 会中のボスへ渡す「当日の随時チャット」の参考情報（Issue #367 / 親 #270）。
 * 表示は #168 で当日1本のタイムラインへ統一されたのに、LLM へ渡す会話履歴は
 * セッション単位のままだったため、ユーザーには1本の会話に見えるのにボスは
 * 会中に随時チャットの発言を参照できない、という齟齬が残っていた。
 *
 * 会話履歴（`messages`）へは混ぜず、system 側の参考情報ブロックとして渡す
 * （#270 論点① 案 C）。`TodaysAdhocMessage` の JSDoc が要求するとおり
 * `created_at` 昇順＝古い順のまま渡す（`listTodaysAdhocMessages` の並びが
 * そのまま契約に一致する）。
 *
 * **随時セッション自身のチャットでは空配列を返す**: そのセッションのメッセージは
 * 既に `listMessagesBySessionId` 経由で会話履歴として渡っており、参考情報にも
 * 載せると同じ発言が二重にトークンを消費し、2回発言されたかのような文脈になる
 * （`TodaysAdhocMessage` の JSDoc が呼び出し側の責務としている二重計上の回避）。
 */
function collectTodaysAdhocContext(
  db: Database.Database,
  sessionType: SessionType,
  now: Date,
): TodaysAdhocMessage[] {
  if (sessionType === "adhoc") {
    return [];
  }
  return listTodaysAdhocMessages(db, now).map((message) => ({
    role: message.role,
    content: message.content,
    sentAt: message.created_at,
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
    const { content, replaceFromMessageId, mentoring: requestedMentoring } = validation.data;

    // やりなおし経路（replaceFromMessageId 指定時）にだけ足すガード
    // （Issue #376, docs/features/chat-message-rewrite.md 決定3・決定1）。
    // 通常送信（未指定）はここを一切通らず、既存の 404/400 の契約のみで
    // 完結する — AC-8d の非回帰。
    if (replaceFromMessageId !== undefined) {
      // `session`（L120）は `await readJsonBody(c)` の前に読んだスナップ
      // ショットなので、その await を挟んで別リクエストが同じセッションを
      // 終了させる余地がある。ここで読み直してから判定することで、
      // 「サーバは `ended_at` を信用元にする」（決定3）を await 跨ぎでも
      // 保つ。
      const currentSession = findSessionById(db, id) ?? session;
      if (currentSession.ended_at !== null) {
        return c.json(
          {
            error: "終了したセッションの発言は編集できません",
            code: "session_already_ended",
          },
          409,
        );
      }

      const target = findMessageInSession(db, id, replaceFromMessageId);
      if (!target) {
        return c.json(
          {
            error: `message ${replaceFromMessageId} not found in session ${id}`,
            code: "message_not_found",
          },
          404,
        );
      }

      if (target.role === "boss") {
        return c.json(
          { error: "ボスの発言は編集できません", code: "message_not_editable" },
          400,
        );
      }
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

    // 切り捨て（やりなおし時のみ）と新しい発言の挿入は単一トランザクション
    // （ADR 0005 決定 5）。片方だけが確定する中間状態を作らない
    // （AC-21）。`insertMessage` より前・`toClaudeMessages(listMessagesBySessionId(...))`
    // より前に切り捨てを終える必要がある（後段だと書き直した発言自身を消す、
    // あるいは元の発言が LLM へ渡ってしまう）。
    //
    // **この位置は下の 2 つの文脈読み出しより前でなければならない**（#270 を
    // 取り込んだ時点で担保対象が 1 本から 2 本に増えた）:
    //   1. `toClaudeMessages(listMessagesBySessionId(...))` — このセッションの会話履歴
    //   2. `collectTodaysAdhocContext(...)` — 会中のボスへ渡す当日の随時チャット（#367）
    // どちらも DB を都度読み直すため、物理 DELETE がここで先に確定していれば
    // 「書き直した後、元の発言はボスの文脈に含まれない」（#255 完了条件）が
    // 両経路で構造的に成り立つ。切り捨てを下へ動かすとこの保証が静かに壊れる。
    if (replaceFromMessageId !== undefined) {
      try {
        db.transaction(() => {
          deleteMessagesFrom(db, id, replaceFromMessageId);
          insertMessage(db, { session_id: id, role: "user", content });
        })();
      } catch (err) {
        // このルートの他の失敗経路（createClaudeClient 初期化失敗）と同じ
        // 規律: ログにはエラークラス名までしか残さない（ADR 0002 決定 4）。
        // db.transaction が自動でロールバックしているため、切り捨てだけが
        // 確定した中間状態にはなっていない（AC-21）。
        console.error(
          "chat message rewrite transaction failed:",
          err instanceof Error ? err.name : typeof err,
        );
        // No `code` field here: unlike the guard rejections above, this
        // failure isn't part of the spec's error-code table (docs/features/
        // chat-message-rewrite.md 「画面・API設計 / API」) — it's an
        // unexpected persistence failure, same shape as this route's other
        // uncoded 500 (the createClaudeClient failure branch above).
        return c.json({ error: "書き直した発言の保存に失敗しました" }, 500);
      }
    } else {
      insertMessage(db, { session_id: id, role: "user", content });
    }
    recordActivityEvent(db, { type: "chat_message" });

    const tasks = listTasks(db);
    const recentDecisions = listRecentDecisions(db, 5);
    // Same "5 most recent" convention as recentDecisions above (Issue #96 —
    // 直近の報告履歴の参照). Feeds AC-2: the boss can refer back to recent
    // morning/evening reports without the user re-explaining them.
    const recentSessionSummaries = listRecentSessionSummaries(db, 5);
    const { model, persona } = resolveBossSettings(db);
    // 時刻の読みは1回にまとめる（Issue #367）。`listTodaysAdhocMessages` は
    // ローカル暦日の半開区間の両端をこの値から導出するため、プロンプト側の
    // `now` と読みが割れると真夜中をまたいで窓が壊れる（`local-day.ts` の
    // `startOfNextLocalDayIso` の JSDoc が同じ理由で引数を必須にしている）。
    const now = new Date();
    // Issue #409（親 #276）: 「朝会 かつ 強制オン」または「リクエストの
    // mentoring」を 1 つの boolean へ合成してから渡す。設定の読み取りと
    // 条件の合成はこのルート（呼び出し側）の責務であり、buildPersonaPrompt
    // は受け取った boolean で分岐するだけの純粋関数のまま
    // （機能仕様「IF（境界となる契約）」・`PersonaPromptContext.mentoring`
    // の JSDoc）。
    const mentoring =
      (session.type === "morning" && resolveMorningMentoringRequired(db)) ||
      requestedMentoring === true;
    const system = buildPersonaPrompt(persona, {
      tasks,
      // 決定 3-a: ボスが自分の裁定（要否）と現状（添付件数）を参照できる
      // ようにする。ボスチャットは update_task ツールで完了操作にも使われる
      // 経路なので、この呼び出し元だけは実件数を渡す必要がある。
      taskEvidenceCounts: countTaskEvidencesByTaskIds(db, tasks.map((task) => task.id)),
      recentDecisions,
      recentSessionSummaries,
      todaysAdhocMessages: collectTodaysAdhocContext(db, session.type, now),
      now,
      sessionType: session.type,
      mentoring,
      // 「今何時か」「締切まであと何時間か」の主経路（Issue #288）
      includeCurrentDateTime: true,
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
      // Issue #462（親 #446 S1）: 正規化済みテキストのうち、既に `text` イベント
      // として送出した長さ。累積文字列を正規化した結果からこの位置以降を切り出す
      // ことで、per-delta では成立しない正規化（`<`／`p`／`>` と分かれて届くと
      // 撤回できない）を、送出済みの内容を撤回せずに実現する。
      let sentNormalizedLength = 0;
      const toolSummaries: string[] = [];
      try {
        /**
         * `source` を正規化し、まだ送出していない差分を返す（無ければ `null`）。
         * 呼び出しごとに `sentNormalizedLength` を進める。
         *
         * `splitPendingTagTail` の単調性により、正規化結果が縮むことはない。
         * それでも `<=` で防いでいるのは、万一縮んだときに `slice` が末尾を
         * 二重送出する形になるのを避けるため。
         */
        const takeUnsentNormalized = (source: string): string | null => {
          const normalized = stripHtmlTags(source);
          if (normalized.length <= sentNormalizedLength) {
            return null;
          }
          const chunk = normalized.slice(sentNormalizedLength);
          sentNormalizedLength = normalized.length;
          return chunk;
        };

        const onTextDelta = (delta: string) => {
          fullText += delta;
          // タグの一部になりうる末尾（最後の `>` より後の `<` 以降）は送出を
          // 保留し、タグが確定するか応答が終了した時点で確定させる。
          const chunk = takeUnsentNormalized(splitPendingTagTail(fullText).committed);
          if (chunk === null) {
            return;
          }
          void stream.writeSSE({
            event: "text",
            data: JSON.stringify({ text: chunk }),
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
        // Issue #462（親 #446 S1）: 生成が完了した時点で保留中のテキストが
        // 残っていれば（`<` が閉じないまま応答が終わった場合など）、追加の
        // `text` イベントとして 1 回送出してから `done` を送る。保留が無ければ
        // このイベントは発生しない。`done` の `content` に反映するだけでは、
        // `text` イベントの断片を連結した結果が確定読み出しと食い違う。
        const pendingChunk = takeUnsentNormalized(fullText);
        if (pendingChunk !== null) {
          await stream.writeSSE({
            event: "text",
            data: JSON.stringify({ text: pendingChunk }),
          });
        }

        // Codex 指摘（PR #467）: フォールバックの判定は**正規化後の結果**で
        // 行う。`fullText !== ""` だけで見ると、LLM が許可リストのマークアップ
        // しか返さなかった場合（`<p></p>` 等）にその生の応答が選ばれてしまい、
        // 正規化を経た `done`／再読み込みの内容が空白のみになる。空応答の
        // フォールバックが既にあるのだから、同じ扱いに寄せる。
        //
        // 保存する `content` は**フォールバックしない限り生のまま**である
        // （「保存 content の扱い」決定を壊さない）。
        const hasVisibleText = stripHtmlTags(fullText).trim() !== "";
        const bossMessage = insertMessage(db, {
          session_id: id,
          role: "boss",
          content: hasVisibleText ? fullText : buildFallbackText(toolSummaries),
        });
        // Issue #461（親 #446 S1）: docs/features/boss-reply-plain-text-output.md
        // クリティカル設計決定「SSE 送出の制約」— `done` の payload だけ
        // `content` を正規化した値へ差し替える。DB へ挿入した行
        // （`bossMessage`、上の insertMessage の戻り値）自体は生のままで、
        // 「保存 content の扱い」決定（書き換えない）と両立させる。
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ ...bossMessage, content: stripHtmlTags(bossMessage.content) }),
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
