// 日報 Markdown のレンダラー（純粋関数）。
//
// docs/features/daily-report.md「日報テンプレート」の固定構成を決定するのは
// この関数だけであり、LLM には構造を作らせない（親要件チケット #100 の
// クリティカル設計決定）。DB・現在時刻・LLM には一切触れず、必要な値は
// すべて引数（RenderDailyReportInput）で受け取る。
//
// 通常経路（eveningSummary あり）とフォールバック経路（eveningSummary が
// null）は、この同一の関数を共用する（フォールバック専用の別テンプレート
// 関数は作らない）。
import { toDateKey } from "../detection/time-utils.js";
import { normalizeDynamicValue } from "./dynamic-value.js";

/** ローカル日付の曜日を漢字1文字で表す（date.getDay() の 0=日 起点） */
const WEEKDAY_KANJI = ["日", "月", "火", "水", "木", "金", "土"] as const;

export const FALLBACK_EVENING_SUMMARY_NOTE =
  "※ ボスの講評の生成に失敗したため、記録の機械整形で出力しています";

/**
 * LLM が夕会の会話から抽出する3値。呼び出し側（生成サービス、依存チケット
 * #107/#108）が抽出を担い、このレンダラーは渡された値をそのまま埋め込む
 * だけ（「翌日への持ち越し」が無い場合の "なし" も呼び出し側が渡す値）。
 */
export interface EveningSummaryValues {
  reportSummary: string;
  bossComment: string;
  carryOver: string;
}

export interface RenderDailyReportInput {
  /** 対象ローカル暦日（表題の日付・曜日に使う） */
  date: Date;
  /** 完了タスクのタイトル一覧（表示順） */
  completedTasks: string[];
  /** 進行中タスクのタイトル一覧（表示順） */
  inProgressTasks: string[];
  /** 当日最初の task_start の時刻。無ければ null */
  firstTaskStartAt: Date | null;
  /** 当日の休憩回数 */
  breakCount: number;
  /** 休憩の対応付け結果の合計時間（分・切り捨て） */
  breakTotalMinutes: number;
  /** 当日の決定事項の content 一覧（created_at 昇順など、表示順は呼び出し側が決める） */
  decisions: string[];
  /** LLM が返す3値。失敗・タイムアウト・形式不正時は null（フォールバック経路） */
  eveningSummary: EveningSummaryValues | null;
}

function formatTimeHHmm(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function renderDailyReport(input: RenderDailyReportInput): string {
  const dateKey = toDateKey(input.date);
  const weekday = WEEKDAY_KANJI[input.date.getDay()];

  const lines: string[] = [];

  lines.push(`# 日報 ${dateKey}（${weekday}）`);
  lines.push("");

  lines.push("## 本日のタスク");
  lines.push("");
  for (const title of input.completedTasks) {
    lines.push(`- [x] ${normalizeDynamicValue(title)}`);
  }
  for (const title of input.inProgressTasks) {
    lines.push(`- [ ] ${normalizeDynamicValue(title)}（進行中）`);
  }
  lines.push("");

  lines.push("## 活動記録");
  lines.push("");
  lines.push(
    input.firstTaskStartAt
      ? `- 着手: ${formatTimeHHmm(input.firstTaskStartAt)}`
      : "- 着手: なし",
  );
  lines.push(
    input.breakCount > 0
      ? `- 休憩: ${input.breakCount}回（合計 ${input.breakTotalMinutes}分）`
      : "- 休憩: なし",
  );
  lines.push("");

  lines.push("## 夕会サマリ");
  lines.push("");
  if (input.eveningSummary) {
    const { reportSummary, bossComment, carryOver } = input.eveningSummary;
    lines.push(`- 報告の要点: ${normalizeDynamicValue(reportSummary)}`);
    lines.push(`- ボスの講評: ${normalizeDynamicValue(bossComment)}`);
    lines.push(`- 翌日への持ち越し: ${normalizeDynamicValue(carryOver)}`);
  } else {
    lines.push(`- ${FALLBACK_EVENING_SUMMARY_NOTE}`);
  }

  if (input.decisions.length > 0) {
    lines.push("");
    lines.push("## 決定事項");
    lines.push("");
    for (const content of input.decisions) {
      lines.push(`- ${normalizeDynamicValue(content)}`);
    }
  }

  return lines.join("\n");
}
