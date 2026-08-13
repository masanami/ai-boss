import type Database from "better-sqlite3";
import { resolveBossSettings } from "../boss/boss-settings.js";
import { buildPersonaPrompt } from "../boss/persona-prompt.js";
import {
  createClaudeClient,
  streamBossMessage,
  type BossLlmClient,
  type BossLlmMessage,
  type BossTextBlock,
} from "../llm/claude-client.js";
import type { Task } from "../tasks/task.js";

/**
 * 通知文面生成。人格プロンプト生成器（purpose: "notification"）＋ Claude
 * クライアントを再利用し、ルール種別・エスカレーションレベル・対象タスクから
 * 短い催促文面を作る。
 *
 * クリティカル設計（Issue #37 明示的な仮定）: Claude API 呼び出しに失敗した
 * 場合（API キー未設定・タイムアウト・レスポンスにテキストが無い等）は必ず
 * `FALLBACK_TEMPLATES` の定型文にフォールバックし、例外を投げない
 * （呼び出し元＝将来のスケジューラを止めない）。
 */

export const RULE_TYPES = [
  "todo_stall",
  "avoidance",
  "break_overrun",
  "silence",
  // Added for the scheduler integration (Issue #38): the detection engine
  // (Issue #36) also fires deadline/meeting rules, which did not exist yet
  // when this module was built (Issue #37). Additive only — the existing
  // four are left unchanged (no renames) so this module's own tests and
  // behavior are unaffected.
  "deadline_overdue",
  "morning_meeting",
  "evening_meeting",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export type EscalationLevel = 1 | 2 | 3;

export interface NotificationBodyRequest {
  ruleType: RuleType;
  escalationLevel: EscalationLevel;
  /** 通知対象のタスク。休憩延伸・無音など特定タスクに紐付かない場合は null。 */
  task: Task | null;
  /** 現在時刻（プロンプトの時間帯ヒントに使う。呼び出し側が注入する） */
  now: Date;
}

/** 1通知あたりのコスト最小化のための小さめの max_tokens（明示的な仮定）。 */
const NOTIFICATION_MAX_TOKENS = 150;

const DEFAULT_TASK_TITLE = "対象のタスク";

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  todo_stall: "未着手",
  avoidance: "回避",
  break_overrun: "休憩延伸",
  silence: "無音",
  deadline_overdue: "締切超過",
  morning_meeting: "朝会未実施",
  evening_meeting: "夕会未実施",
};

const ESCALATION_LEVEL_LABELS: Record<EscalationLevel, string> = {
  1: "穏やかな声かけ",
  2: "念押し",
  3: "強い催促",
};

function buildUserInstruction(request: NotificationBodyRequest): string {
  const taskLine = request.task
    ? `対象タスク: ${request.task.title}`
    : "対象タスク: 特定のタスクに紐付かない";
  const silenceHint =
    request.ruleType === "silence" && request.escalationLevel === 1
      ? "\n無音検知の初回は詰問ではなく確認から入ること（例:「今何をやっている？」）。"
      : "";

  return [
    "催促通知の文面を1つ生成せよ。",
    `ルール種別: ${RULE_TYPE_LABELS[request.ruleType]}`,
    `エスカレーションレベル: L${request.escalationLevel}（${ESCALATION_LEVEL_LABELS[request.escalationLevel]}）`,
    taskLine,
    "出力は通知本文のみとし、前置き・説明・カギ括弧などの装飾は付けないこと。1〜2文の短い文章にすること。" +
      silenceHint,
  ].join("\n");
}

function extractText(message: BossLlmMessage): string {
  return message.content
    .filter((block): block is BossTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

type FallbackTemplate = (taskTitle: string) => string;

const FALLBACK_TEMPLATES: Record<
  RuleType,
  Record<EscalationLevel, FallbackTemplate>
> = {
  todo_stall: {
    1: (title) => `そろそろ${title}に着手しよう。`,
    2: (title) => `${title}、まだ手をつけていないな。早く着手しろ。`,
    3: (title) => `${title}を放置しすぎだ。今すぐ着手しろ。`,
  },
  avoidance: {
    1: (title) => `優先度の高い${title}が進んでいない。そちらに集中しよう。`,
    2: (title) => `${title}を後回しにし続けているな。本筋に戻れ。`,
    3: (title) => `${title}をいつまで避けるつもりだ。今すぐ取り掛かれ。`,
  },
  break_overrun: {
    1: () => "休憩の予定時間を過ぎている。そろそろ戻ろう。",
    2: () => "休憩が長引いているぞ。切り上げて戻れ。",
    3: () => "休憩時間を大幅に超過している。今すぐ戻れ。",
  },
  silence: {
    1: () => "今何をやっている？進捗を教えてくれ。",
    2: () => "しばらく反応がないな。状況を報告しろ。",
    3: () => "長時間音沙汰なしだ。今すぐ状況を報告しろ。",
  },
  deadline_overdue: {
    1: (title) => `${title}の締切を過ぎている。早めに片付けよう。`,
    2: (title) => `${title}、締切をとっくに過ぎているぞ。早く終わらせろ。`,
    3: (title) => `${title}の締切超過が長引いている。今すぐ片付けろ。`,
  },
  morning_meeting: {
    1: () => "朝会の時間だ。今日の予定を報告してくれ。",
    2: () => "朝会がまだだ。早く予定を報告しろ。",
    3: () => "朝会を無視し続けているぞ。今すぐ予定を報告しろ。",
  },
  evening_meeting: {
    1: () => "夕会の時間だ。今日の進捗を報告してくれ。",
    2: () => "夕会がまだだ。早く進捗を報告しろ。",
    3: () => "夕会を無視し続けているぞ。今すぐ進捗を報告しろ。",
  },
};

/** Generic, level-agnostic fallback used when `escalationLevel` is outside
 * the known 1-3 range. `notifications.escalation_level` has no CHECK
 * constraint, so this guards the module's core "never throws" contract
 * against malformed data reaching this function (defensive; see PR
 * discussion for Issue #37). */
const GENERIC_FALLBACK_TEMPLATE: FallbackTemplate = (title) =>
  `${title}の状況を確認してくれ。`;

function resolveFallbackTemplate(request: NotificationBodyRequest): FallbackTemplate {
  return (
    FALLBACK_TEMPLATES[request.ruleType]?.[request.escalationLevel] ??
    GENERIC_FALLBACK_TEMPLATE
  );
}

function buildFallbackBody(request: NotificationBodyRequest): string {
  const title = request.task?.title ?? DEFAULT_TASK_TITLE;
  return resolveFallbackTemplate(request)(title);
}

/**
 * 通知文面を生成する。Claude API が使えない・失敗した場合も必ず文字列を返す
 * （フォールバック定型文）。
 */
export async function generateNotificationBody(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  request: NotificationBodyRequest,
): Promise<string> {
  // クライアント生成（API キー）・設定読み取り（DB）・Claude 呼び出しの
  // いずれで失敗しても、フォールバック定型文で必ず文面を返す
  // （resolveBossSettings は db.prepare を呼ぶため DB 例外もここで保護する）。
  try {
    const client: BossLlmClient = createClaudeClient(env);
    const { model, persona } = resolveBossSettings(db);
    const system = buildPersonaPrompt(persona, {
      tasks: request.task ? [request.task] : [],
      recentDecisions: [],
      now: request.now,
      purpose: "notification",
    });

    const message = await streamBossMessage(client, {
      model,
      system,
      messages: [{ role: "user", content: buildUserInstruction(request) }],
      maxTokens: NOTIFICATION_MAX_TOKENS,
    });

    const text = extractText(message);
    if (text === "") {
      return buildFallbackBody(request);
    }
    return text;
  } catch (err) {
    // Claude API errors may embed request internals in `message` — only log
    // the error's class name (same convention as chat-messages-route.ts).
    console.error(
      "notification body: generation failed, falling back to template:",
      err instanceof Error ? err.name : typeof err,
    );
    return buildFallbackBody(request);
  }
}
