import type Database from "better-sqlite3";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { resolveLlmBackend } from "../config.js";
import {
  createClaudeClient,
  createBossMessage,
  type BossLlmMessage,
  type BossTextBlock,
} from "../llm/claude-client.js";
import { listTasks } from "../tasks/tasks-repository.js";
import type { SessionType } from "./session.js";

/**
 * 朝会・夕会の開始ひとこと生成（Issue #271、機能仕様
 * docs/features/meeting-start-announcement.md 判断1〜4）。
 *
 * `dashboard/boss-comment.ts` の既存パターンをそのまま踏襲する（新しい流儀を
 * 増やさない）: 例外を投げない契約・固定フォールバック文言・小さい
 * `maxTokens`・`thinking: { type: "disabled" }`・失敗ログはエラークラス名の
 * み。異なる点は2つだけ:
 * - `buildPersonaPrompt` に `sessionType` を渡す（`purpose` は指定せず既定の
 *   "chat" のままにする — "notification" を渡すと `MORNING_FLOW_INSTRUCTION`
 *   / `EVENING_FLOW_INSTRUCTION` が付かなくなるため。判断1）。
 * - 生成に 10 秒のタイムアウトを設ける（`sessions-routes.ts` の日報生成
 *   20 秒より短い。会の入口は対話のレイテンシが直接効くため。判断4・
 *   明示的な仮定3）。
 */

export type MeetingSessionType = Extract<SessionType, "morning" | "evening">;

export interface MeetingOpeningResult {
  text: string;
  /** false のとき `text` はフォールバック文言。 */
  succeeded: boolean;
}

/** 生成タイムアウト（ms）。判断4・明示的な仮定3。 */
const MEETING_OPENING_TIMEOUT_MS = 10_000;

/** `boss-comment.ts` の `DASHBOARD_COMMENT_MAX_TOKENS` と同じ理由（開始ひとことも
 * 短文であり、同程度の予算で足りる）。 */
const MEETING_OPENING_MAX_TOKENS = 150;

/** 明示的な仮定4: 朝会・夕会で別文言にする。ボス像（決定の形で断言する）と
 * 整合させ、装飾なしの命令口調にする。 */
export const MORNING_OPENING_FALLBACK = "今日の予定を報告しろ。優先順位はこっちで決める。";
export const EVENING_OPENING_FALLBACK = "今日の進捗を報告しろ。";

const FALLBACK_TEXT: Record<MeetingSessionType, string> = {
  morning: MORNING_OPENING_FALLBACK,
  evening: EVENING_OPENING_FALLBACK,
};

const USER_INSTRUCTION =
  "会の開始にあたり、ユーザーへ最初のひとことを述べよ。出力は本文のみとし、前置き・説明・" +
  "カギ括弧などの装飾は付けないこと。1〜2文の短い文章にすること。";

function extractText(message: BossLlmMessage): string {
  return message.content
    .filter((block): block is BossTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * 開始ひとことを生成すべきかどうかを判定する純粋関数（判断2・判断3）。
 * `sessionType` が morning/evening であること（AC-3: adhoc は対象外）と、
 * 対象セッションのメッセージが0件であること（AC-6: 冪等性ガード）の両方を
 * 満たすときのみ true。HTTP ルート・LLM 呼び出しを介さずに両方の分岐を
 * 単体テストできるよう、判定だけを切り出している。
 */
export function shouldGenerateMeetingOpening(
  sessionType: SessionType,
  existingMessageCount: number,
): sessionType is MeetingSessionType {
  return (
    (sessionType === "morning" || sessionType === "evening") &&
    existingMessageCount === 0
  );
}

type TimedResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * `promise` に `timeoutMs` の上限を課す。上限を超えた場合は `{ timedOut: true }`
 * を返すが、`promise` 自体はキャンセルしない（`reports/extract-evening-summary.ts`
 * の `withOptionalTimeout` と同じ理由・同じ形 — Claude API/Agent SDK 呼び出しに
 * 汎用的なキャンセル手段が無いため）。上限超過後に `promise` が reject しても
 * 拒否ハンドラを必ず登録しているため unhandled rejection にはならない。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `sessionType`（morning/evening）の開始ひとことを生成する。例外は決して
 * 投げない: バックエンド解決・クライアント生成・API 呼び出し・タイムアウトの
 * いずれが失敗しても `{ text: <固定フォールバック>, succeeded: false }` を
 * 返す（呼び出し元＝`POST /api/sessions` を失敗させない。AC-4・AC-5）。
 *
 * 呼び出し側（`sessions-routes.ts`）で {@link shouldGenerateMeetingOpening}
 * を通した上で呼ぶことを想定しており、この関数自身はガード判定を行わない
 * （関心の分離）。
 */
export async function generateMeetingOpening(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
  sessionType: MeetingSessionType,
): Promise<MeetingOpeningResult> {
  const fallback = FALLBACK_TEXT[sessionType];
  try {
    const backend = resolveLlmBackend(env);
    const client = createClaudeClient(env, backend);
    const { model, persona } = resolveBossSettings(db);
    const tasks = listTasks(db);
    // purpose は指定しない（既定 "chat"）。sessionType を渡すことで
    // MORNING_FLOW_INSTRUCTION / EVENING_FLOW_INSTRUCTION が乗る
    // （persona-prompt.ts の resolveSessionFlowInstruction は purpose ===
    // "chat" のときだけ効く — 判断1）。
    const system = buildPersonaPrompt(persona, {
      tasks,
      recentDecisions: [],
      now,
      sessionType,
    });

    const outcome = await withTimeout(
      createBossMessage(client, {
        model,
        system,
        messages: [{ role: "user", content: USER_INSTRUCTION }],
        maxTokens: MEETING_OPENING_MAX_TOKENS,
        // boss-comment.ts と同じ理由: 小さい maxTokens と thinking は
        // 両立しないため明示的に無効化する。
        thinking: { type: "disabled" },
      }),
      MEETING_OPENING_TIMEOUT_MS,
    );

    if (outcome.timedOut) {
      console.error(
        `meeting opening: generation timed out after ${MEETING_OPENING_TIMEOUT_MS}ms, falling back`,
      );
      return { text: fallback, succeeded: false };
    }

    const text = extractText(outcome.value);
    if (text === "") {
      return { text: fallback, succeeded: false };
    }
    return { text, succeeded: true };
  } catch (err) {
    // Claude API のエラーはリクエスト内部情報を含みうるため、クラス名のみ
    // ログに残す（boss-comment.ts / notification-body.ts と同じ規約。
    // ADR 0002 決定4）。
    console.error(
      "meeting opening: generation failed, falling back to template:",
      err instanceof Error ? err.name : typeof err,
    );
    return { text: fallback, succeeded: false };
  }
}
