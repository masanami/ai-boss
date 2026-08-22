// 作業ログ Markdown のレンダラー（純粋関数）。
//
// 作業ログテンプレートの固定構成を決定するのはこの関数だけ
// （docs/adr/0006-renderer-owns-structure.md）。
// DB・現在時刻・LLM には一切触れず、必要な値はすべて引数
// （RenderWorkLogInput）で受け取る（collect-work-log-data.ts が既に
// タスク名を解決済みの状態で渡す）。
import { toDateKey } from "../detection/time-utils.js";
import { normalizeDynamicValue } from "./dynamic-value.js";
import type { WorkLogActivityEventType } from "./collect-work-log-data.js";
import type { DecisionStatus } from "../decisions/decision.js";

/** ローカル日付の曜日を漢字1文字で表す（date.getDay() の 0=日 起点） */
const WEEKDAY_KANJI = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 当日の決定・対象イベントが1件も無い場合の固定本文 */
export const NO_RECORDS_NOTE = "（記録なし）";

/** `task_id` が null、または参照先タスクが存在しない場合の共通ラベル */
const UNSPECIFIED_TASK_LABEL = "（タスク未指定）";

const DECISION_LABELS: Record<DecisionStatus, string> = {
  active: "決定",
  revised: "決定（改訂済み）",
  withdrawn: "決定（撤回）",
};

/** `（予定 {n}分）` を付与する対象の activity_events 種別 */
const EXPECTED_MINUTES_TYPES = new Set<WorkLogActivityEventType>(["task_start", "break_start"]);

export interface RenderWorkLogDecisionEntry {
  id: number;
  status: DecisionStatus;
  content: string;
  createdAt: Date;
}

export interface RenderWorkLogActivityEntry {
  id: number;
  type: WorkLogActivityEventType;
  taskTitle: string | null;
  note: string | null;
  expectedMinutes: number | null;
  createdAt: Date;
}

export interface RenderWorkLogInput {
  /** 対象ローカル暦日（表題の日付・曜日に使う） */
  date: Date;
  decisions: RenderWorkLogDecisionEntry[];
  activityEvents: RenderWorkLogActivityEntry[];
}

type MergedEntry =
  | ({ kind: "decision" } & RenderWorkLogDecisionEntry)
  | ({ kind: "activity" } & RenderWorkLogActivityEntry);

function formatTimeHHmm(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * `created_at` 昇順。同時刻は activity_events を決定より先に置き、同一種類
 * （activity_events 同士・決定同士）では `id` 昇順とする
 * （順序が決定的になるようにする。docs/adr/0006-renderer-owns-structure.md 決定 1）。
 */
function compareEntries(a: MergedEntry, b: MergedEntry): number {
  const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  if (a.kind !== b.kind) {
    return a.kind === "activity" ? -1 : 1;
  }
  return a.id - b.id;
}

function formatActivityBody(entry: RenderWorkLogActivityEntry): string {
  const taskTitle =
    entry.taskTitle === null ? UNSPECIFIED_TASK_LABEL : normalizeDynamicValue(entry.taskTitle);
  switch (entry.type) {
    case "task_start":
      return `着手: ${taskTitle}`;
    case "task_update":
      return `タスク更新: ${taskTitle}`;
    case "task_pause":
      return `一時停止: ${taskTitle}`;
    case "break_start":
      return "休憩開始";
    case "break_end":
      return "休憩終了";
    case "checkin":
      return "チェックイン";
  }
}

function formatEntry(entry: MergedEntry): string {
  const time = formatTimeHHmm(entry.createdAt);

  if (entry.kind === "decision") {
    const label = DECISION_LABELS[entry.status];
    return `- ${time} ${label}: ${normalizeDynamicValue(entry.content)}`;
  }

  let suffix = "";
  if (EXPECTED_MINUTES_TYPES.has(entry.type) && entry.expectedMinutes !== null) {
    suffix += `（予定 ${entry.expectedMinutes}分）`;
  }
  if (entry.note !== null) {
    suffix += ` — ${normalizeDynamicValue(entry.note)}`;
  }

  return `- ${time} ${formatActivityBody(entry)}${suffix}`;
}

export function renderWorkLog(input: RenderWorkLogInput): string {
  const dateKey = toDateKey(input.date);
  const weekday = WEEKDAY_KANJI[input.date.getDay()];

  const lines: string[] = [];
  lines.push(`# 作業ログ ${dateKey}（${weekday}）`);
  lines.push("");

  const merged: MergedEntry[] = [
    ...input.activityEvents.map((entry): MergedEntry => ({ kind: "activity", ...entry })),
    ...input.decisions.map((entry): MergedEntry => ({ kind: "decision", ...entry })),
  ].sort(compareEntries);

  if (merged.length === 0) {
    lines.push(NO_RECORDS_NOTE);
  } else {
    for (const entry of merged) {
      lines.push(formatEntry(entry));
    }
  }

  return lines.join("\n");
}
