import { streamSSE } from "hono/streaming";
import type { Hono } from "hono";
import type { Db } from "../db/db-port.js";
import type Anthropic from "@anthropic-ai/sdk";
import { readJsonBody } from "../lib/read-json-body.js";
import { stripHtmlTags, splitPendingTagTail } from "../lib/strip-html-tags.js";
import { recordActivityEvent } from "../activity/activity-events-repository.js";
import { findTaskById, listTasks } from "../tasks/tasks-repository.js";
import { countTaskEvidencesByTaskIds } from "../tasks/task-evidences-repository.js";
import {
  listDecisionsByTaskId,
  listMentoredTaskIds,
  listRecentDecisions,
} from "../decisions/decisions-repository.js";
import { resolveBossSettingsFrom } from "../boss/boss-settings.js";
import { resolveMorningMentoringRequiredFrom } from "../settings/mentoring-settings.js";
import { readSettingsSnapshot } from "../settings/settings-repository.js";
import {
  buildPersonaPrompt,
  type TodaysAdhocMessage,
} from "../boss/persona-prompt.js";
import { BOSS_TOOLS, executeBossTool } from "../boss/boss-tools.js";
import { resolveLlmSelection, type LlmSelection } from "../llm/llm-selection.js";
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
import { deferStateChangeNotice } from "../state-change-notice.js";
import type { LlmBackendName } from "../llm/llm-backend-registry.js";
import { RelayUsageLimitError, describeUsageLimitReached } from "../llm/relay-usage-limit.js";

/** Sanitized message surfaced to the client; never includes raw error details
 * (which may contain request internals) per the critical API-key/error
 * handling requirement. */
const GENERIC_STREAM_ERROR_MESSAGE = "ボスの応答中にエラーが発生しました";

/**
 * 対象タスクの過去記録としてプロンプトへ積む最大件数（S2b・Issue #545, 親
 * #438 決定16）。`listRecentDecisions(db, 5)` と同じ「直近5件」の慣習
 * （件数の指定はこのルートの責務。`listDecisionsByTaskId` 自身は limit を
 * 受け取るだけで既定値を持たない）。
 */
const TASK_RELATED_RECORD_LIMIT = 5;

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
 *
 * ボスの過去発言（`role: "boss"`）にのみ `stripHtmlTags` を掛けてから写す
 * （Issue #558 / 親 #446 S2）。根拠は「表示と履歴の一致」——画面に出るボスの
 * 発言は正規化済みなので、ボスが続きを書く会話履歴も同じ文字列に揃える。
 * ユーザーの発言は本人が打った文字列そのものであり、触らない。保存された
 * `messages.content` は生のまま残す（ここで変えるのは LLM へ渡す写しだけ）。
 *
 * 正規化すると可視テキストが残らないボスの行（例: `<strong>` の直後で停止
 * された中断行。中断経路は生文字列の非空だけを見て保存する）は写さずに落とす。
 * Anthropic Messages API は空・空白のみの content を拒否するため、写すと
 * `api` バックエンドでそのセッションの以後の全ターンが落ち続ける。判定は
 * 完了経路の `hasVisibleText` と同じ。連続した `user` は API 側で 1 ターンに
 * 結合されるので、落としても要求の形は壊れない。
 */
function toClaudeMessages(messages: Message[]): Anthropic.MessageParam[] {
  const normalized: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role !== "boss") {
      normalized.push({ role: "user", content: message.content });
      continue;
    }
    const content = stripHtmlTags(message.content);
    if (content.trim() !== "") {
      normalized.push({ role: "assistant", content });
    }
  }

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
async function collectTodaysAdhocContext(
  db: Db,
  sessionType: SessionType,
  now: Date,
): Promise<TodaysAdhocMessage[]> {
  if (sessionType === "adhoc") {
    return [];
  }
  return (await listTodaysAdhocMessages(db, now)).map((message) => ({
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

interface RewriteRejection {
  status: 400 | 404 | 409;
  body: { error: string; code: string };
}

/**
 * やりなおし（`replaceFromMessageId`）の可否の検査（Issue #376,
 * docs/features/chat-message-rewrite.md 決定3・決定1）: 会が終了していない
 * こと・対象の発言がこの会にあること・ボスの発言でないこと。拒否なら応答の
 * 形を返し、許可なら `undefined`。早期の拒否と、書き直しのトランザクションの
 * 中の確定の判定（T6・#605）の両方から呼ぶ。
 */
async function checkRewriteTarget(
  db: Db,
  sessionId: number,
  replaceFromMessageId: number,
): Promise<RewriteRejection | undefined> {
  // 会は削除されない（セッション行の物理削除は無い）ので、見つからないのは
  // 起こらない。見つからなければ終了済みとは扱わず、既存の判定に任せる。
  const currentSession = await findSessionById(db, sessionId);
  if (currentSession !== undefined && currentSession.ended_at !== null) {
    return {
      status: 409,
      body: { error: "終了したセッションの発言は編集できません", code: "session_already_ended" },
    };
  }

  const target = await findMessageInSession(db, sessionId, replaceFromMessageId);
  if (!target) {
    return {
      status: 404,
      body: {
        error: `message ${replaceFromMessageId} not found in session ${sessionId}`,
        code: "message_not_found",
      },
    };
  }

  if (target.role === "boss") {
    return {
      status: 400,
      body: { error: "ボスの発言は編集できません", code: "message_not_editable" },
    };
  }
  return undefined;
}

function describeClientInitFailure(err: unknown): string {
  return err instanceof Error ? err.message : "failed to initialize the Claude client";
}

/**
 * Registers `POST /:id/messages` on the given sessions router. Kept in its
 * own module because the SSE + tool-use orchestration is substantially
 * larger than the other session endpoints in `sessions-routes.ts`.
 *
 * The LLM backend and model are resolved by the selection resolver
 * (機能仕様 docs/features/llm-provider-abstraction.md クリティカル設計決定 5
 * 「S2 の形」・`llm/llm-selection.ts`). Two resolutions exist, with different
 * roles:
 *  - the *preflight* (before the user message is saved) only decides whether
 *    a client can be created at all, so that an initialization failure still
 *    answers 500 before anything is recorded — the existing order;
 *  - the *turn* resolution, from the turn's own settings snapshot (#618),
 *    yields the `{ backend, model }` pair that is actually sent. If its
 *    backend differs from the preflight's, the client is created again for
 *    it. The preflight client is never paired with a model from a different
 *    resolution, so a save landing mid-request cannot send one provider's
 *    model through another provider's client (仮定 A19・A21).
 */
export function registerChatMessageRoute(
  router: Hono,
  db: Db,
  env: NodeJS.ProcessEnv,
): void {
  router.post("/:id/messages", async (c) => {
    const rawId = c.req.param("id");
    const id = Number(rawId);

    const session = await findSessionById(db, id);
    if (!session) {
      return c.json(
        { error: "セッションが見つかりません", code: "session_not_found" },
        404,
      );
    }

    const body = await readJsonBody(c);
    const validation = validateChatMessageInput(body);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }
    const {
      content,
      replaceFromMessageId,
      mentoring: requestedMentoring,
      mentoringTaskId,
    } = validation.data;

    // Issue #471（親 #444 決定7）: 存在検証は DB を読むためルート側の責務
    // （純粋関数である sessions-validation.ts には持ち込まない）。ユーザー
    // 発言を保存する前（insertMessage より前）に判定する — 拒否されたリク
    // エストのユーザー発言だけが残る中間状態を作らないため。
    if (mentoringTaskId !== undefined && !(await findTaskById(db, mentoringTaskId))) {
      return c.json(
        {
          error: "対象のタスクが見つかりません",
          code: "mentoring_task_not_found",
        },
        404,
      );
    }

    // やりなおし経路（replaceFromMessageId 指定時）にだけ足すガード
    // （Issue #376, docs/features/chat-message-rewrite.md 決定3・決定1）。
    // 通常送信（未指定）はここを一切通らず、既存の 404/400 の契約のみで
    // 完結する — AC-8d の非回帰。
    if (replaceFromMessageId !== undefined) {
      // `session`（L120）は `await readJsonBody(c)` の前に読んだスナップ
      // ショットなので、その await を挟んで別リクエストが同じセッションを
      // 終了させる余地がある。ここで読み直してから判定することで、
      // 「サーバは `ended_at` を信用元にする」（決定3）を await 跨ぎでも
      // 保つ。ここは早期の拒否（Claude クライアントの初期化より前に 4xx を
      // 返す既存の応答順を保つ）で、確定の判定は下の書き直しのトランザク
      // ションの中でもう一度行う（T6・#605）。
      const rejection = await checkRewriteTarget(db, id, replaceFromMessageId);
      if (rejection) {
        return c.json(rejection.body, rejection.status);
      }
    }

    // 事前の確認（従来の位置）: クライアントを作れなければ、発言を保存する前に
    // 500 で返す。ここで得たクライアントは、下の 1 ターン分の解決の結果が同じ
    // バックエンドのときにだけ使う。
    let client: BossLlmClient;
    let preflightBackend: LlmBackendName;
    try {
      const { backend } = resolveLlmSelection(env, await readSettingsSnapshot(db));
      preflightBackend = backend;
      client = createClaudeClient(env, backend);
    } catch (err) {
      return c.json({ error: describeClientInitFailure(err) }, 500);
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
    //
    // T6（#605・機能仕様 docs/features/async-db-layer.md 決定 2）: 会の終了済み
    // と書き直し対象の検査を、切り捨て＋挿入と同じトランザクションの中で
    // やり直す。上の早期の検査から Claude クライアントの初期化までの間に
    // 別の要求が会を終了させても、その終了はこの書き込みが確定するまで
    // 待たされるか（AC-20）、先に確定していればここで 409 になる。
    if (replaceFromMessageId !== undefined) {
      let rejection: RewriteRejection | undefined;
      try {
        rejection = await db.transaction(async (tx) => {
          const check = await checkRewriteTarget(tx, id, replaceFromMessageId);
          if (check) {
            return check;
          }
          await deleteMessagesFrom(tx, id, replaceFromMessageId);
          await insertMessage(tx, { session_id: id, role: "user", content });
          return undefined;
        });
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
      if (rejection) {
        return c.json(rejection.body, rejection.status);
      }
    } else {
      await insertMessage(db, { session_id: id, role: "user", content });
    }
    await recordActivityEvent(db, { type: "chat_message" });

    // 1 ターン分のプロンプト材料は 1 つのトランザクションでスナップショット
    // として読む（#618・機能仕様 docs/features/async-db-layer.md 決定 2）。
    // 個別の `await` の間には直列化層のロックが外れるため、途中で設定の保存や
    // タスクの更新が割り込むと、どの時点にも存在しなかった新旧の組み合わせが
    // プロンプトに入りうる。LLM の呼び出しはこのトランザクションの外に置く
    // （ロックを応答生成のあいだ持ち続けない）。
    const turn = await db.transaction(
      async (tx) => {
        const tasks = await listTasks(tx);
        const recentDecisions = await listRecentDecisions(tx, 5);
        // Same "5 most recent" convention as recentDecisions above (Issue #96 —
        // 直近の報告履歴の参照). Feeds AC-2: the boss can refer back to recent
        // morning/evening reports without the user re-explaining them.
        const recentSessionSummaries = await listRecentSessionSummaries(tx, 5);
        // 設定由来の値（モデル・ペルソナ・朝会の必須メンタリング）は 1 つの
        // スナップショットから導く（#618。`resolveBossSettings` と
        // `resolveMorningMentoringRequired` を別々に読むと、その間の保存で新旧が混ざる）。
        const settings = await readSettingsSnapshot(tx);
        // 送るバックエンドとモデルは、このターンのスナップショットから選択の
        // 解決関数で 1 回だけ決める（#582 クリティカル設計決定 5）。事前の確認の
        // 後に選択が未選択などへ変わっていれば、ここで失敗する（発言は保存済み）。
        let selection: LlmSelection;
        try {
          selection = resolveLlmSelection(env, settings);
        } catch (error) {
          return { ok: false as const, error };
        }
        const { persona } = resolveBossSettingsFrom(settings);
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
          (session.type === "morning" && resolveMorningMentoringRequiredFrom(settings)) ||
          requestedMentoring === true;
        // Issue #471（親 #444 決定3・決定7の結線）: mentoringTaskId は
        // mentoring が真のときだけ後段（プロンプト・ツール実行）へ渡す。
        // バリデーションで mentoringTaskId は requestedMentoring === true の
        // ときにしか存在しない（決定7）ので、この時点では常に mentoring も
        // 真だが、契約として明示的に mentoring でゲートする。
        const mentoringTaskIdForTurn = mentoring ? mentoringTaskId : undefined;
        // S2b・Issue #545（親 #438 決定16・17）: 対象タスクに紐づく過去の決定・
        // メンタリング記録を、listRecentDecisions とは別経路
        // （listDecisionsByTaskId、kind で絞らない）で引く。mentoringTaskIdForTurn
        // が undefined のとき（mentoring が偽、または mentoringTaskId 未指定）は
        // クエリ自体を発行しない — buildPersonaPrompt 側でも AND 条件でゲート
        // されるが、無駄な DB アクセスを避ける。
        const taskRelatedRecords =
          mentoringTaskIdForTurn === undefined
            ? undefined
            : await listDecisionsByTaskId(tx, mentoringTaskIdForTurn, TASK_RELATED_RECORD_LIMIT);
        // Issue #706（親 #561 決定11）: 朝会の未確認タスクの判定に使う、メンタリング
        // 記録を持つタスクの id。タスク一覧と同じトランザクション（#618）で読み、
        // 朝会以外のターンではクエリ自体を発行しない（使わないため）。
        const mentoredTaskIds =
          session.type === "morning" ? await listMentoredTaskIds(tx) : undefined;
        const system = buildPersonaPrompt(persona, {
          tasks,
          // 決定 3-a: ボスが自分の裁定（要否）と現状（添付件数）を参照できる
          // ようにする。ボスチャットは update_task ツールで完了操作にも使われる
          // 経路なので、この呼び出し元だけは実件数を渡す必要がある。
          taskEvidenceCounts: await countTaskEvidencesByTaskIds(
            tx,
            tasks.map((task) => task.id),
          ),
          recentDecisions,
          recentSessionSummaries,
          todaysAdhocMessages: await collectTodaysAdhocContext(tx, session.type, now),
          now,
          sessionType: session.type,
          mentoring,
          // Issue #468（親 #444 決定3）: 対象タスクをプロンプトへ積む結線。
          mentoringTaskId: mentoringTaskIdForTurn,
          // Issue #545（親 #438 決定16・17）: 対象タスクの過去記録の結線。
          taskRelatedRecords,
          // Issue #706（親 #561 決定11）: 朝会の未確認セクションの結線。
          mentoredTaskIds,
          // 「今何時か」「締切まであと何時間か」の主経路（Issue #288）
          includeCurrentDateTime: true,
        });
        const messages = toClaudeMessages(await listMessagesBySessionId(tx, id));
        return { ok: true as const, selection, system, messages, mentoringTaskIdForTurn };
      },
    );
    if (!turn.ok) {
      return c.json({ error: describeClientInitFailure(turn.error) }, 500);
    }
    const { selection, system, messages, mentoringTaskIdForTurn } = turn;
    const { model } = selection;
    // 組のバックエンドが事前の確認と同じなら、そのクライアントをそのまま使う
    // （同じ `env` と名前から作ったクライアントは入れ替えても振る舞いが変わらない
    // — 仮定 A19）。違えば組のバックエンドで作り直す。作れなければ 500（発言は
    // 保存済みのまま残る — LLM の応答の生成の失敗と同じ扱い。仮定 A21）。
    if (selection.backend !== preflightBackend) {
      try {
        client = createClaudeClient(env, selection.backend);
      } catch (err) {
        return c.json({ error: describeClientInitFailure(err) }, 500);
      }
    }

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

    // #585 S2: ボスのツールはこのストリームの中で状態を変えるため、計画し直しの
    // 契機（`createCoreApp` の `onStateChangingRequest`）にはストリームの後始末が
    // 終わったことを伝える（state-change-notice.ts）。生成を止められたとき、
    // 中断メッセージの保存と、止められた時点で実行中だったツールの完了
    // （claude-code バックエンドでは生成の中止がツールの完了を待たない）の後に
    // 解決する。
    let finishStateChanges!: () => void;
    deferStateChangeNotice(c.req.raw, new Promise<void>((resolve) => (finishStateChanges = resolve)));
    const runningTools = new Set<Promise<unknown>>();

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

        // Issue #469（親 #444 決定5）: 対象タスクを record_mentoring の
        // task_id 補完へ結線する。
        const executeTool: BossToolExecutor = (name, input) => {
          const running = executeBossTool(db, id, name, input, mentoringTaskIdForTurn);
          runningTools.add(running);
          return running;
        };

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
        const bossMessage = await insertMessage(db, {
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
        //
        // Codex 指摘（PR #467）: 永続化するのは **配信済みに対応する raw の
        // 接頭辞**であって `fullText` 全体ではない。中断時は 424 行の
        // フラッシュが走らないため、保留中の末尾（`"回答は x < 10"` の
        // `"< 10"` のような未閉じ `<` 以降）はクライアントへ届いていない。
        // `fullText` をそのまま保存すると、停止直後に web が保持している
        // 配信済み接頭辞と、`GET /messages` の再読み込み結果が食い違う
        // （未閉じ `<` は正規化で除去されないのでそのまま現れる）。
        //
        // `splitPendingTagTail` は純粋関数なので、ここで最終 `fullText` に
        // 掛けた `committed` は、最後の delta 時点で送出判断に使った値と
        // 同一になる。保存するのは**その raw の接頭辞**であり、正規化した
        // 値ではない（「保存 content は非正規化」の決定を壊さない）。
        const deliveredRawText = splitPendingTagTail(fullText).committed;
        if (deliveredRawText !== "") {
          try {
            await insertMessage(db, {
              session_id: id,
              role: "boss",
              content: deliveredRawText,
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
          //
          // 中継の上限到達（日・月）だけは、利用者が次にどうすればよいか分かる
          // 固定の文言（上限が戻る時刻つき）にする（機能仕様
          // docs/features/llm-relay-server.md 決定 S2-Q6）。再試行の枠組みは再試行
          // 不可の失敗を元の型のまま投げるため `instanceof` で判定できる。
          const errorMessage =
            err instanceof RelayUsageLimitError
              ? describeUsageLimitReached(err.limit, new Date())
              : GENERIC_STREAM_ERROR_MESSAGE;
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: errorMessage }),
          });
        }
      } finally {
        await Promise.allSettled(runningTools);
        finishStateChanges();
      }
    });
  });
}
