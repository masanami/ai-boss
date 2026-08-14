import type Database from "better-sqlite3";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { resolveLlmBackend, type LlmBackend } from "../config.js";
import {
  createClaudeClient,
  createBossMessage,
  type BossLlmMessage,
  type BossTextBlock,
} from "../llm/claude-client.js";
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
 *
 * FR-14（Issue #79）: `claude-code` バックエンドは `DASHBOARD_COMMENT_MAX_TOKENS`
 * に相当する応答長の直接制御手段を持たないため、プロンプトへ短文指示を追加し
 * （`CLAUDE_CODE_SHORT_TEXT_INSTRUCTION`）、生成後に全角 80 字相当を超えて
 * いないか検証する。超過時は「空応答」と同じ扱いでテンプレートフォールバック
 * する（`api` バックエンドの挙動は変えない — ロジック変更は最小限）。
 */

const DASHBOARD_COMMENT_MAX_TOKENS = 150;

const FALLBACK_COMMENT = "今日も決めたことを淡々とこなせ。";

const USER_INSTRUCTION =
  "ダッシュボードに表示する「今日のひとこと」を1つ生成せよ。現在のタスク状況を踏まえて、" +
  "今日一日のモチベーションになる短い一言にすること。出力は本文のみとし、前置き・説明・" +
  "カギ括弧などの装飾は付けないこと。1文の短い文章にすること。";

/** `claude-code` バックエンドのみに追加する短文指示（FR-14）。応答長の
 * リクエスト単位制御（`maxTokens` 相当）が無いための代替。テストが直接
 * 参照できるよう export する。 */
export const CLAUDE_CODE_SHORT_TEXT_INSTRUCTION =
  "出力は1文とし、全角80字以内（半角文字は0.5字として数える）に収めること。";

/** 全角 80 字相当の長さ検証用（FR-14）。半角相当の文字（U+0000–U+00FF）は
 * 0.5 字、それ以外は 1 字として数える単純な近似。 */
const DASHBOARD_COMMENT_MAX_ZENKAKU_LENGTH = 80;

function zenkakuEquivalentLength(text: string): number {
  let length = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    length += codePoint <= 0xff ? 0.5 : 1;
  }
  return length;
}

function buildUserInstruction(backend: LlmBackend): string {
  if (backend === "claude-code") {
    return `${USER_INSTRUCTION}\n${CLAUDE_CODE_SHORT_TEXT_INSTRUCTION}`;
  }
  return USER_INSTRUCTION;
}

function extractText(message: BossLlmMessage): string {
  return message.content
    .filter((block): block is BossTextBlock => block.type === "text")
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
    const backend = resolveLlmBackend(env);
    const client = createClaudeClient(env, backend);
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
      messages: [{ role: "user", content: buildUserInstruction(backend) }],
      maxTokens: DASHBOARD_COMMENT_MAX_TOKENS,
    });

    const text = extractText(message);
    if (text === "") {
      return { text: FALLBACK_COMMENT, succeeded: false };
    }
    if (backend === "claude-code" && zenkakuEquivalentLength(text) > DASHBOARD_COMMENT_MAX_ZENKAKU_LENGTH) {
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
