import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { createClaudeClient, createBossMessage } from "../llm/claude-client.js";
import { listTasks } from "../tasks/tasks-repository.js";
import { toDateKey } from "../detection/time-utils.js";
import { getCachedBossComment, setCachedBossComment } from "./boss-comment-cache.js";

/**
 * ダッシュボードの「今日のひとこと」生成（Issue #58）。人格プロンプト生成器
 * （purpose: "notification"）＋ Claude クライアントで生成し、ローカル日付
 * 単位で `boss-comment-cache.ts` にキャッシュする。同日 2 回目以降のリクエスト
 * では Claude API を呼ばない。
 *
 * `notification-body.ts` と同じ契約: API キー未設定・API エラー・空応答の
 * いずれでも例外を投げず、必ず `FALLBACK_COMMENT` を返す（呼び出し元＝
 * ダッシュボード API を 500 にしない、明示的な仮定）。フォールバックは
 * キャッシュしない（次回リクエストで再度生成を試みる）。
 */

const DASHBOARD_COMMENT_MAX_TOKENS = 150;

const FALLBACK_COMMENT = "今日も決めたことを淡々とこなせ。";

const USER_INSTRUCTION =
  "ダッシュボードに表示する「今日のひとこと」を1つ生成せよ。現在のタスク状況を踏まえて、" +
  "今日一日のモチベーションになる短い一言にすること。出力は本文のみとし、前置き・説明・" +
  "カギ括弧などの装飾は付けないこと。1文の短い文章にすること。";

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

interface GenerationResult {
  text: string;
  /** false のとき `text` はフォールバック文言（キャッシュしない判断に使う）。 */
  succeeded: boolean;
}

async function generateBossComment(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<GenerationResult> {
  try {
    const client = createClaudeClient(env);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks: listTasks(db),
      recentDecisions: [],
      now,
      purpose: "notification",
    });

    const message = await createBossMessage(client, {
      model,
      system,
      messages: [{ role: "user", content: USER_INSTRUCTION }],
      maxTokens: DASHBOARD_COMMENT_MAX_TOKENS,
    });

    const text = extractText(message);
    if (text === "") {
      return { text: FALLBACK_COMMENT, succeeded: false };
    }
    return { text, succeeded: true };
  } catch (err) {
    // Claude API のエラーはリクエスト内部情報を含みうるため、クラス名のみ
    // ログに残す（chat-messages-route.ts / notification-body.ts と同じ規約）。
    console.error(
      "dashboard boss comment: generation failed, falling back to template:",
      err instanceof Error ? err.name : typeof err,
    );
    return { text: FALLBACK_COMMENT, succeeded: false };
  }
}

/**
 * 今日のひとことをキャッシュから取得する。キャッシュが無ければ Claude で
 * 生成し、成功した場合のみキャッシュへ保存する（フォールバック文言は
 * キャッシュしない）。
 */
export async function getOrGenerateBossComment(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<string> {
  const todayKey = toDateKey(now);

  const cached = getCachedBossComment(db, todayKey);
  if (cached !== undefined) {
    return cached;
  }

  const result = await generateBossComment(db, env, now);
  if (result.succeeded) {
    setCachedBossComment(db, todayKey, result.text);
  }
  return result.text;
}
