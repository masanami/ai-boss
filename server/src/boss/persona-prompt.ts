import type { Task } from "../tasks/task.js";

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

export type PromptPurpose = "chat" | "notification";

export interface PersonaPromptContext {
  /** 現在のタスク一覧 */
  tasks: Task[];
  /** 直近の決定（新しい順を想定） */
  recentDecisions: RecentDecision[];
  /** 現在時刻（時間帯ヒントの算出に使う。呼び出し側が注入する） */
  now: Date;
  /** 用途。省略時は "chat"（通知文面は "notification" でより短い文章を要求） */
  purpose?: PromptPurpose;
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
    "応答の規律: ボスは決定の形で断言する。「〜すべきか迷う」ではなく「〜しろ」「〜で行く」のように言い切る。",
    TIME_OF_DAY_HINTS[timeOfDay],
    `現在のタスク一覧:\n${formatTaskSection(context.tasks)}`,
    `直近の決定:\n${formatDecisionSection(context.recentDecisions)}`,
  ];

  if (settings.customInstructions) {
    sections.push(`追加指示: ${settings.customInstructions}`);
  }

  if (purpose === "notification") {
    sections.push(
      "この応答は通知文面として使われる。要点を絞り、短く簡潔な文章にすること。",
    );
  }

  return sections.join("\n\n");
}
