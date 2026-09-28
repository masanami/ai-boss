import { buildPersonaCharacterSections, type PersonaSettings } from "../boss/persona-prompt.js";
import type { ClaudeMessageRequest } from "../llm/claude-client.js";
import { stripHtmlTags } from "../lib/strip-html-tags.js";
import {
  ESCALATION_LEVEL_LABELS,
  RULE_TYPES,
  RULE_TYPE_LABELS,
  type EscalationLevel,
  type RuleType,
} from "../notifications/notification-body.js";

/**
 * 人格設定ごとの文面セット（機能仕様 docs/features/scheduled-nudges.md
 * 決定 4 の C）。8 ルール × 3 段階 × 3 通り ＝ 72 文。タスク名は
 * {@link TASK_PLACEHOLDER}、約束の時刻は {@link TIME_PLACEHOLDER} の差し込み。
 */
export type MessageSet = Record<RuleType, Record<EscalationLevel, [string, string, string]>>;

export const TASK_PLACEHOLDER = "{task}";
export const TIME_PLACEHOLDER = "{time}";
export const MESSAGE_SET_VARIANTS = 3;

const ESCALATION_LEVELS: EscalationLevel[] = [1, 2, 3];

/** 1 文の長さの上限（通知の本文として不自然に長い応答を形の不一致として弾く） */
const MAX_MESSAGE_LENGTH = 200;

/**
 * C の生成の最大トークン数（仮定 A13）。72 文の JSON は出力 3,000〜4,000
 * トークンの見積もり（決定 4 の費用の表）で、途中で切れて形が壊れない余裕を
 * 持たせる。
 */
const MESSAGE_SET_MAX_TOKENS = 6000;

const MESSAGE_SET_INSTRUCTION = [
  "予約して送る催促通知の文面の見本を、ルールと段階の組ごとに 3 通りずつ作れ。",
  "各文面は通知本文そのものとし、1〜2 文の短い文章にすること。前置き・説明・カギ括弧・Markdown は付けないこと。",
  `タスクの名前が要る箇所には ${TASK_PLACEHOLDER} と書くこと（送るときにタスク名へ置き換える）。`,
  `約束の時刻が要る箇所には ${TIME_PLACEHOLDER} と書くこと（「約束の時刻を過ぎても未着手」のみ）。`,
  "段階が上がるほど口調を強めること。",
  "出力は次の形の JSON だけとし、それ以外の文字を含めないこと: " +
    '{"<ルールのキー>": {"1": ["文面", "文面", "文面"], "2": [...], "3": [...]}, ...}',
  "ルールのキーと意味:",
  ...RULE_TYPES.map((rule) => `- ${rule}: ${RULE_TYPE_LABELS[rule]}`),
  "段階:",
  ...ESCALATION_LEVELS.map((level) => `- ${level}: L${level}（${ESCALATION_LEVEL_LABELS[level]}）`),
].join("\n");

/**
 * C の LLM への要求を組み立てる。送るのは人格設定（名前・口調・厳しさ・
 * カスタム指示）とルール・段階の名前だけで、タスクの情報・現在日時・時間帯の
 * ヒントを含めない（決定 4）。人格プロンプト（`buildPersonaPrompt`）はタスク
 * 一覧と時間帯のヒントを必ず含むため使わない。
 */
export function buildMessageSetLlmRequest(model: string, persona: PersonaSettings): ClaudeMessageRequest {
  const sections = [...buildPersonaCharacterSections(persona)];
  if (persona.customInstructions) {
    sections.push(`追加指示: ${persona.customInstructions}`);
  }
  return {
    model,
    system: sections.join("\n\n"),
    messages: [{ role: "user", content: MESSAGE_SET_INSTRUCTION }],
    maxTokens: MESSAGE_SET_MAX_TOKENS,
    thinking: { type: "disabled" },
  };
}

function parseVariants(value: unknown): [string, string, string] | null {
  if (!Array.isArray(value) || value.length !== MESSAGE_SET_VARIANTS) return null;
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const normalized = stripHtmlTags(item).trim();
    if (normalized === "" || normalized.length > MAX_MESSAGE_LENGTH) return null;
    texts.push(normalized);
  }
  return texts as [string, string, string];
}

/**
 * C の応答を文面セットとして読む。8 ルール × 3 段階 × 3 通りの形でなければ
 * `null`（欠け・空の文・JSON でない・長すぎる文）。応答の前後に余計な文字が
 * あっても、最初の `{` から最後の `}` までを JSON として読む。
 */
export function parseMessageSet(text: string): MessageSet | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const result = {} as MessageSet;
  for (const rule of RULE_TYPES) {
    const byLevel = (parsed as Record<string, unknown>)[rule];
    if (typeof byLevel !== "object" || byLevel === null) return null;
    const levels = {} as Record<EscalationLevel, [string, string, string]>;
    for (const level of ESCALATION_LEVELS) {
      const variants = parseVariants((byLevel as Record<string, unknown>)[String(level)]);
      if (!variants) return null;
      levels[level] = variants;
    }
    result[rule] = levels;
  }
  return result;
}

/**
 * 3 通りのどれを使うかを予約 ID（仮定 A9）から決定的に選ぶ（仮定 A13）。
 * 同じ予約は計画し直しても同じ文になる。
 */
export function chooseVariantIndex(reservationKey: string): number {
  let sum = 0;
  for (let i = 0; i < reservationKey.length; i++) {
    sum = (sum + reservationKey.charCodeAt(i)) % MESSAGE_SET_VARIANTS;
  }
  return sum;
}

/** 差し込み（タスク名・約束の時刻）を置き換える */
export function fillMessageTemplate(template: string, taskTitle: string, commitmentTime: string): string {
  // 1 回の走査で置き換える（タスク名に `{time}` が含まれていても置き換えない）
  return template.replace(/\{task\}|\{time\}/g, (placeholder) =>
    placeholder === TASK_PLACEHOLDER ? taskTitle : commitmentTime,
  );
}
