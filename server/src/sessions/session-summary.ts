import type Database from "better-sqlite3";
import type { LlmBackend } from "../config.js";
import { resolveBossSettings } from "../boss/boss-settings.js";
import {
  createClaudeClient,
  createBossMessage,
  type BossLlmMessage,
  type BossTextBlock,
} from "../llm/claude-client.js";
import { listMessagesBySessionId } from "./messages-repository.js";
import type { Message, MessageRole } from "./message.js";

/**
 * セッション終了時の要約生成（Issue #96）。会話履歴（messages）から、後日
 * ボスがこの会話を思い出すための短い要約を1回のノンストリーミング呼び出しで
 * 生成する。
 *
 * `notification-body.ts` / `boss-comment.ts` と同じ「例外を投げない」契約に
 * 揃える（呼び出し元＝セッション終了 API を失敗させない）。ただしこの2つと
 * 異なり、失敗時に捏造した定型文へフォールバックしない: 要約は事実の記録で
 * あり、生成できなければ `null`（未要約のまま）が正しい。定型フォールバック
 * 文は持たない（明示的な仮定、Issue #96 PR 参照）。
 */

/** 要約1件あたりのコスト最小化のための小さめの max_tokens（明示的な仮定）。 */
const SUMMARY_MAX_TOKENS = 300;

const SUMMARY_SYSTEM_PROMPT =
  "あなたはセッションの会話ログから、後日ボス自身がこの会話を思い出すための要約を作る。" +
  "日本語で数文にまとめること。決めたこと・報告された進捗・未達とその理由・持ち越しを" +
  "落とさないこと。前置きや説明・装飾（「以下要約」「要約：」等）を付けず、要約の本文のみを" +
  "出力すること。";

const ROLE_LABELS: Record<MessageRole, string> = {
  user: "ユーザー",
  boss: "ボス",
};

function formatConversation(messages: Message[]): string {
  return messages
    .map((message) => `${ROLE_LABELS[message.role]}: ${message.content}`)
    .join("\n");
}

function extractText(message: BossLlmMessage): string {
  return message.content
    .filter((block): block is BossTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * `sessionId` の会話履歴から要約を生成して返す。メッセージが0件のセッション
 * は Claude を呼ばずに `null` を返す（空セッションを終了しただけで API
 * コストを払わないため）。生成テキストが空文字のときも `null` を返す。
 *
 * 例外は決して投げない: メッセージ取得・クライアント生成・API 呼び出しの
 * いずれが失敗しても `null` を返す。エラーログは例外の `message` を出さず
 * クラス名のみを出す（Claude API のエラーはリクエスト内部情報を message に
 * 埋め込みうるため — `notification-body.ts` / `chat-messages-route.ts` と
 * 同じ規約）。
 */
export async function generateSessionSummary(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  llmBackend: LlmBackend,
  sessionId: number,
): Promise<string | null> {
  try {
    const messages = listMessagesBySessionId(db, sessionId);
    if (messages.length === 0) {
      return null;
    }

    const client = createClaudeClient(env, llmBackend);
    const { model } = resolveBossSettings(db);

    const message = await createBossMessage(client, {
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: formatConversation(messages) }],
      maxTokens: SUMMARY_MAX_TOKENS,
      // Issue #117: same rationale as boss-comment.ts/notification-body.ts —
      // this route's small `maxTokens` (300) is sized for the summary text
      // alone, so thinking must stay off. Set explicitly so it's part of
      // this route's own pinned contract.
      thinking: { type: "disabled" },
    });

    const text = extractText(message);
    return text === "" ? null : text;
  } catch (err) {
    console.error(
      "session summary: generation failed:",
      err instanceof Error ? err.name : typeof err,
    );
    return null;
  }
}
