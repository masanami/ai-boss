// 日報生成の「値の抽出」段（収集 → 値の抽出 → レンダリング → 保存 の4段の
// うち2段目。docs/adr/0006-renderer-owns-structure.md）。
// 夕会セッションの会話メッセージ＋当日の active 決定一覧を
// Claude に渡し、「報告の要点」「ボスの講評」「決定の要点」「翌日への持ち越し」
// の4値だけを構造化応答（submit_evening_summary ツール、`evening-summary-tool.ts`）
// で取得する。
//
// `server/src/dashboard/boss-comment.ts` / `server/src/notifications/notification-body.ts`
// と同じフォールバック契約: 例外を投げず、失敗時は null を返す。失敗に含める
// もの: API キー未設定（MissingApiKeyError）／ClaudeCodeUnavailableError／
// LLM 呼び出しエラー／タイムアウト／ツール未呼び出し／入力の形式不正・空文字
// （親要件チケット #100 のクリティカル設計決定）。
import type Database from "better-sqlite3";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import { resolveLlmBackend } from "../config.js";
import {
  createClaudeClient,
  requestVerdict,
  type BossLlmClient,
} from "../llm/claude-client.js";
import type { Message } from "../sessions/message.js";
import type { EveningSummaryValues } from "./render-daily-report.js";
import {
  parseEveningSummaryToolInput,
  SUBMIT_EVENING_SUMMARY_TOOL,
} from "./evening-summary-tool.js";

const ROLE_LABELS: Record<Message["role"], string> = {
  user: "ユーザー",
  boss: "ボス",
};

function buildTranscript(messages: Message[]): string {
  return messages
    .map((message) => `${ROLE_LABELS[message.role]}: ${message.content}`)
    .join("\n");
}

/**
 * 当日の `status = active` 決定一覧（content のみ・作成日時昇順で呼び出し
 * 側から渡される）を箇条書きにする。0件の場合は「（決定なし）」と明示し、
 * LLM が「決定の要点」を「なし」と書く判断材料にする（保証 G-170-49・
 * 抽出材料の詳細は Issue #144）。
 */
function buildDecisionsList(decisionContents: string[]): string {
  if (decisionContents.length === 0) {
    return "（決定なし）";
  }
  return decisionContents.map((content) => `- ${content}`).join("\n");
}

function buildUserInstruction(messages: Message[], decisionContents: string[]): string {
  return [
    "以下は夕会（報告セッション）の会話ログと、当日の決定一覧である。この内容を踏まえて、必ず submit_evening_summary ツールで" +
      "「報告の要点」「ボスの講評」「決定の要点」「翌日への持ち越し」の4つの値を提出せよ。",
    "「決定の要点」は当日の決定のうち最終状態として効いているもの（確定ノルマ・新規タスク登録・持ち越し判断等）の要約とし、" +
      "該当が無い場合は key_decisions に「なし」と明記すること（空文字は不可）。",
    "翌日への持ち越しが無い場合は carry_over に「なし」と明記すること（空文字は不可）。",
    "",
    "--- 当日の決定一覧 ---",
    buildDecisionsList(decisionContents),
    "",
    "--- 夕会の会話ログ ---",
    buildTranscript(messages),
  ].join("\n");
}

export interface ExtractEveningSummaryOptions {
  /** 抽出ステップの任意の上限時間（ms）。超過時は4値なし（null）として扱う。
   * 未指定時はタイムアウトを設けない（LLM クライアント既定の方針に委ねる —
   * 既定20秒を渡すのは夕会終了フック側の責務。ここでは受け口だけ用意する）。*/
  timeoutMs?: number;
}

type TimedResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * `promise` に `timeoutMs` の上限を課す。上限を超えた場合は `{ timedOut: true }`
 * を返すが、`promise` 自体はキャンセルしない（Claude API/Agent SDK 呼び出しに
 * 汎用的なキャンセル手段が無いため）。`promise` が後から解決/拒否されても
 * 既に確定した外側の Promise には影響しない。拒否ハンドラは必ず登録するため、
 * 上限超過後に `promise` が reject しても unhandled rejection にはならない。
 */
function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<TimedResult<T>> {
  if (timeoutMs === undefined) {
    return promise.then((value) => ({ timedOut: false as const, value }));
  }

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
 * 夕会セッションの会話メッセージ＋当日の active 決定一覧から、日報の
 * 「夕会サマリ」4値を抽出する。
 *
 * `api` バックエンドでは `toolChoice` でツール呼び出しを強制する。`claude-code`
 * バックエンド（`toolChoice` 非対応）は、システムプロンプト（purpose:
 * "daily-report"、`persona-prompt.ts`）とこの関数のユーザーメッセージ双方の
 * 指示文でツール呼び出しを促す代替をとる（既存の踏襲）。
 *
 * `decisionContents` は当日（ローカル日付）の `status = active` 決定の
 * `content` 一覧（作成日時昇順・呼び出し側 `generate-daily-report.ts` が
 * `collectDailyReportData` の結果をそのまま渡す）。「決定の要点」抽出の
 * 材料としてユーザーメッセージへ注入するだけで、この関数自身は DB を
 * 読まない（保証 G-170-54・経緯は Issue #144）。
 *
 * 例外を投げず、失敗時は null を返す（呼び出し側 `generate-daily-report.ts`
 * は null を「同じレンダラーへ4値なしで渡す」フォールバック経路として扱う）。
 */
export async function extractEveningSummary(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  eveningMessages: Message[],
  decisionContents: string[],
  now: Date,
  options: ExtractEveningSummaryOptions = {},
): Promise<EveningSummaryValues | null> {
  try {
    const backend = resolveLlmBackend(env);
    const client: BossLlmClient = createClaudeClient(env, backend);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks: [],
      recentDecisions: [],
      now,
      purpose: "daily-report",
    });

    const requestPromise = requestVerdict(
      client,
      {
        model,
        system,
        messages: [
          { role: "user", content: buildUserInstruction(eveningMessages, decisionContents) },
        ],
        tools: [SUBMIT_EVENING_SUMMARY_TOOL],
        // api バックエンドのみ toolChoice でツール呼び出しを強制する。
        // claude-code は toolChoice 非対応のため渡さない（プロンプト指示で代替）。
        ...(backend === "api"
          ? { toolChoice: { type: "tool" as const, name: "submit_evening_summary" } }
          : {}),
        // `thinking` は指定せずファサード既定（`{ type: "disabled" }`）に
        // 依存する（Issue #117・appeals-route.ts と同じ理由）。構造化抽出な
        // ので思考は不要で、`toolChoice` によるツール強制との併用も避ける。
      },
      "submit_evening_summary",
      parseEveningSummaryToolInput,
    );

    const outcome = await withOptionalTimeout(requestPromise, options.timeoutMs);

    if (outcome.timedOut) {
      console.error(
        `daily report evening summary: extraction timed out after ${options.timeoutMs}ms, falling back`,
      );
      return null;
    }

    const verdict = outcome.value;
    if (!verdict.called) {
      console.error("daily report evening summary: submit_evening_summary was not called");
      return null;
    }

    if (!verdict.result.valid) {
      console.error(
        "daily report evening summary: invalid tool input:",
        verdict.result.error,
      );
      return null;
    }

    return verdict.result.data;
  } catch (err) {
    // Claude API/Agent SDK のエラーはリクエスト内部情報を含みうるため、
    // クラス名のみログに残す（boss-comment.ts / notification-body.ts と同じ
    // 規約）。
    console.error(
      "daily report evening summary: extraction failed, falling back:",
      err instanceof Error ? err.name : typeof err,
    );
    return null;
  }
}
