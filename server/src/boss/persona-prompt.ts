import type { Task } from "../tasks/task.js";
import type { SessionType } from "../sessions/session.js";

export const TONE_PRESETS = ["reliable", "strict", "logical", "passionate"] as const;
export type TonePreset = (typeof TONE_PRESETS)[number];

export const DEFAULT_TONE_PRESET: TonePreset = "reliable";
export const MIN_STRICTNESS = 1;
export const MAX_STRICTNESS = 5;
export const DEFAULT_STRICTNESS = 3;

export interface PersonaSettings {
  /** ボスの名前。プロンプト内の自己紹介に使う */
  name: string;
  /** 口調プリセット */
  tone: TonePreset;
  /** 厳しさレベル 1..5（既定 3） */
  strictness: number;
  /** 自由記述の追加指示。無ければ null */
  customInstructions: string | null;
}

export const DEFAULT_PERSONA_SETTINGS: PersonaSettings = {
  name: "ボス",
  tone: DEFAULT_TONE_PRESET,
  strictness: DEFAULT_STRICTNESS,
  customInstructions: null,
};

/**
 * 直近の決定事項（decisions テーブル相当）の表示に必要な最小情報。
 * decisions テーブル・リポジトリは未実装（別チケット）のため、ここではローカルに
 * 最小限の型を定義する。将来 decisions リポジトリを呼び出し側で実装する際は
 * `decisions.created_at` を `decidedAt` にマッピングして渡すこと。
 */
export interface RecentDecision {
  content: string;
  decidedAt: string;
}

/**
 * 直近の報告履歴（セッション要約）の表示に必要な最小情報。`sessions.summary`
 * （Issue #96 `session-summary.ts` が生成）を `sessions-repository.ts` の
 * `listRecentSessionSummaries` がこの形にマッピングして渡す。`RecentDecision`
 * と同じ「呼び出し側でマッピングして渡す」流儀。
 */
export interface RecentSessionSummary {
  type: SessionType;
  content: string;
  reportedAt: string;
}

export type PromptPurpose = "chat" | "notification";

export interface PersonaPromptContext {
  /** 現在のタスク一覧 */
  tasks: Task[];
  /** 直近の決定（新しい順を想定） */
  recentDecisions: RecentDecision[];
  /**
   * 直近の報告履歴（朝会/夕会の要約、新しい順を想定）。任意プロパティ:
   * 既存の呼び出し元（`notification-body.ts` / `boss-comment.ts`）は
   * decisions と違い当面これを渡さないため、未指定時は空配列として扱う
   * （後方互換）。
   */
  recentSessionSummaries?: RecentSessionSummary[];
  /** 現在時刻（時間帯ヒントの算出に使う。呼び出し側が注入する） */
  now: Date;
  /** 用途。省略時は "chat"（通知文面は "notification" でより短い文章を要求） */
  purpose?: PromptPurpose;
  /**
   * セッション種別。morning/evening のときのみ専用のフロー指示を追加する。
   * adhoc または省略時は追加指示なし（従来どおり）。
   */
  sessionType?: SessionType;
}

const TONE_DESCRIPTIONS: Record<TonePreset, string> = {
  reliable:
    "普段の口調は穏やかで合理的に。相手のやる気をそがない言い方をするが、変に持ち上げたりお世辞を言ったりはしない（過剰な賞賛は禁止）。サボりが続くとエスカレーションに応じて口調は明確に厳しくなる（信頼と甘さは別物）。",
  strict:
    "妥協のない厳格な口調で。緩みや先延ばしを見逃さず、率直に指摘する。",
  logical:
    "感情を排したロジカルな口調で。根拠とデータに基づき、淡々と結論を伝える。",
  passionate:
    "熱血な口調で情熱的に鼓舞する。気合を入れつつも、最終的な決定は明確に下す。",
};

const STRICTNESS_DESCRIPTIONS: Record<number, string> = {
  1: "厳しさレベル 1: とても緩やか。多少の遅れや先延ばしは大目に見る。",
  2: "厳しさレベル 2: 緩やか。基本的には寛容に構える。",
  3: "厳しさレベル 3: 標準。妥当な範囲で厳しさを保つ。",
  4: "厳しさレベル 4: 厳しめ。遅れや先延ばしには早めに指摘する。",
  5: "厳しさレベル 5: 非常に厳しい。妥協せず即座に指摘する。",
};

const TASK_STATUS_LABELS: Record<Task["status"], string> = {
  todo: "未着手",
  in_progress: "進行中",
  done: "完了",
  dropped: "取り下げ",
};

const TASK_PRIORITY_LABELS: Record<NonNullable<Task["priority"]>, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

type TimeOfDay = "朝" | "日中" | "夕方" | "夜";

const TIME_OF_DAY_HINTS: Record<TimeOfDay, string> = {
  朝: "朝: 一日の計画を確認し、最優先タスクへの着手を促すタイミング。",
  日中: "日中: 進捗を見守り、サボりの兆候（未着手・回避・休憩延伸・無音）があれば指摘するタイミング。",
  夕方: "夕方: 今日の成果を振り返り、未達タスクの扱いを裁定するタイミング。",
  夜: "夜: 一日の終わり。無理な追い込みは促さず、翌日への引き継ぎを意識するタイミング。",
};

// strictness は設定画面（Issue #8）で担保される想定だが、settings テーブル由来の
// 値が想定外に壊れていた場合でもプロンプトに欠落や "undefined" を出さないよう、
// 純粋関数側でも既定レベルへ安全にフォールバックする
function resolveStrictnessDescription(strictness: number): string {
  return (
    STRICTNESS_DESCRIPTIONS[strictness] ??
    STRICTNESS_DESCRIPTIONS[DEFAULT_STRICTNESS]
  );
}

function resolveTimeOfDay(now: Date): TimeOfDay {
  const hour = now.getHours();
  if (hour >= 5 && hour < 10) {
    return "朝";
  }
  if (hour >= 10 && hour < 17) {
    return "日中";
  }
  if (hour >= 17 && hour < 20) {
    return "夕方";
  }
  return "夜";
}

function formatTaskLine(task: Task): string {
  const status = TASK_STATUS_LABELS[task.status];
  const priority = task.priority ? TASK_PRIORITY_LABELS[task.priority] : "未設定";
  const dueAt = task.due_at ?? "未設定";
  return `- [${status}] ${task.title}（優先度: ${priority} / 締切: ${dueAt}）`;
}

function formatTaskSection(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "現在登録されているタスクはありません。";
  }
  return tasks.map(formatTaskLine).join("\n");
}

function formatDecisionLine(decision: RecentDecision): string {
  return `- ${decision.decidedAt}: ${decision.content}`;
}

function formatDecisionSection(decisions: RecentDecision[]): string {
  if (decisions.length === 0) {
    return "直近の決定はまだありません。";
  }
  return decisions.map(formatDecisionLine).join("\n");
}

// resolveStrictnessDescription と同じ防御的フォールバックの作法: DB 由来の
// `type` が将来 SessionType の想定外の値を持っていても "undefined" を
// プロンプトに出さない。
const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  morning: "朝会",
  evening: "夕会",
  adhoc: "相談",
};

function resolveSessionTypeLabel(type: SessionType): string {
  return SESSION_TYPE_LABELS[type] ?? "セッション";
}

// 日時は formatDecisionLine と同じく保存されている ISO 文字列をそのまま出す。
// 先頭10文字へ切り詰めると UTC 基準の日付になり、JST 午前9時より前に行った
// セッションが前日として提示されてしまう（保存値は toISOString() 由来の UTC）。
function formatSessionSummaryLine(summary: RecentSessionSummary): string {
  return `- ${summary.reportedAt} ${resolveSessionTypeLabel(summary.type)}: ${summary.content}`;
}

function formatSessionSummarySection(summaries: RecentSessionSummary[]): string {
  if (summaries.length === 0) {
    return "直近の報告履歴はまだありません。";
  }
  return summaries.map(formatSessionSummaryLine).join("\n");
}

// 朝会/夕会のガイドはシステムプロンプトによる誘導のみで実現し、ステップ管理の
// 状態機械はサーバーに持たない（Issue #47 明示的な仮定）。
const MORNING_FLOW_INSTRUCTION =
  "これは朝会（計画セッション）。ユーザーから今日の予定の報告を受けたら、タスクの優先順位と今日のノルマを決定の形で提示し、" +
  "create_task / update_task でタスクへ反映すること。各タスクの所要時間はざっくり見積もって提案し、ユーザーが同意または修正した" +
  "値だけを estimated_minutes に保存すること（ユーザーの確認前に保存してはならない）。優先順位・ノルマの決定は record_decision で記録すること。";

const EVENING_FLOW_INSTRUCTION =
  "これは夕会（報告セッション）。ユーザーから進捗の報告を受けたら、タスクごとに達成/未達を評価すること。未達タスクは理由を確認した" +
  "うえで、持ち越し（締切変更・継続・取り下げ）を裁定し update_task で反映すること。裁定は record_decision で記録すること。";

const TASK_ESTIMATE_CONFIRMATION_INSTRUCTION =
  "チャットからタスクを新規作成するときは、所要時間の見積もりを提案し、ユーザーが確認（同意または修正）した値だけを" +
  "estimated_minutes に保存すること（確認前に保存してはならない）。";

function resolveSessionFlowInstruction(
  sessionType: SessionType | undefined,
): string | null {
  if (sessionType === "morning") {
    return MORNING_FLOW_INSTRUCTION;
  }
  if (sessionType === "evening") {
    return EVENING_FLOW_INSTRUCTION;
  }
  return null;
}

/**
 * ボスの人格設定と現在のコンテキストから、Claude API に渡すシステムプロンプトを
 * 組み立てる純粋関数。チャット応答・通知文面生成の両方から共用される。
 */
export function buildPersonaPrompt(
  settings: PersonaSettings,
  context: PersonaPromptContext,
): string {
  const purpose = context.purpose ?? "chat";
  const timeOfDay = resolveTimeOfDay(context.now);

  const sections: string[] = [
    `あなたは「${settings.name}」という名前のAIボス。ユーザーのセルフマネジメントを支援する上司役を演じる。`,
    TONE_DESCRIPTIONS[settings.tone],
    resolveStrictnessDescription(settings.strictness),
    "応答の規律: ボスは決定の形で断言する。「〜すべきか迷う」ではなく「〜しろ」「〜で行く」のように言い切る。" +
      "優先順位・ノルマ・締切・持ち越し等の重要な裁定を下したときは record_decision ツールで記録すること。",
    TIME_OF_DAY_HINTS[timeOfDay],
    `現在のタスク一覧:\n${formatTaskSection(context.tasks)}`,
    `直近の決定:\n${formatDecisionSection(context.recentDecisions)}`,
    `直近の報告履歴:\n${formatSessionSummarySection(context.recentSessionSummaries ?? [])}`,
  ];

  if (settings.customInstructions) {
    sections.push(`追加指示: ${settings.customInstructions}`);
  }

  if (purpose === "notification") {
    sections.push(
      "この応答は通知文面として使われる。要点を絞り、短く簡潔な文章にすること。",
    );
  } else {
    const sessionFlowInstruction = resolveSessionFlowInstruction(
      context.sessionType,
    );
    if (sessionFlowInstruction) {
      sections.push(sessionFlowInstruction);
    }
    sections.push(TASK_ESTIMATE_CONFIRMATION_INSTRUCTION);
  }

  return sections.join("\n\n");
}
