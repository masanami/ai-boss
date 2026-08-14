// 日報生成の「値の抽出」段（docs/features/daily-report.md「機能全体の設計 >
// アーキテクチャ決定」の4段のうち2段目）で使うツール定義。
//
// `server/src/decisions/verdict-tool.ts` に倣い、JSON Schema ＋ 入力バリデータ
// を1ファイルにまとめる。LLM に Markdown を組み立てさせない（親要件チケット
// #100 のクリティカル設計決定）ため、ツールが要求するのは「報告の要点」
// 「ボスの講評」「翌日への持ち越し」の3つの**値**のみで、見出し・箇条書き
// 記法などの構造は一切含めない。
import type Anthropic from "@anthropic-ai/sdk";
import type { EveningSummaryValues } from "./render-daily-report.js";

export const SUBMIT_EVENING_SUMMARY_TOOL: Anthropic.Tool = {
  name: "submit_evening_summary",
  description:
    "夕会（報告セッション）の会話ログから「報告の要点」「ボスの講評」「翌日への持ち越し」の3つの値を抽出して提出する。" +
    "Markdown の見出し・箇条書き記号・装飾は使わず、それぞれ簡潔な平文（1〜2文程度）で書くこと。" +
    "翌日への持ち越しが無い場合は carry_over に「なし」と明記すること（省略・空文字は不可）。",
  input_schema: {
    type: "object",
    properties: {
      report_summary: {
        type: "string",
        description: "ユーザーが夕会で報告した内容の要点（平文・簡潔に）",
      },
      boss_comment: {
        type: "string",
        description: "その報告に対するボスの講評・評価コメント（平文・簡潔に）",
      },
      carry_over: {
        type: "string",
        description:
          "翌日への持ち越し事項の要約。持ち越しが無い場合は「なし」と書くこと（空文字は不可）。",
      },
    },
    required: ["report_summary", "boss_comment", "carry_over"],
  },
};

/** `submit_evening_summary` ツールの入力（バリデート済み）。フィールドは
 * `render-daily-report.ts`（#106）の `EveningSummaryValues` とそのまま対応
 * させ、呼び出し側（抽出ステップ）で変換なしにレンダラーへ渡せるようにする。*/
export type EveningSummaryToolInput = EveningSummaryValues;

export type EveningSummaryParseResult =
  | { valid: true; data: EveningSummaryToolInput }
  | { valid: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 空文字（前後の空白のみを含む文字列を含む）は不正形として扱う
 * （docs/features/daily-report.md「LLM による3値抽出」の受入基準）。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `submit_evening_summary` の tool_use 入力を検証する。3値はすべて必須かつ
 * 空文字不可（`parseVerdictToolInput` と同じ厳格さ）。1つでも欠落・空文字
 * があれば `valid: false` を返し、呼び出し側（抽出ステップ）はこれを
 * 「不正形」としてフォールバック（3値なし）へ倒す。
 */
export function parseEveningSummaryToolInput(
  input: unknown,
): EveningSummaryParseResult {
  if (!isRecord(input)) {
    return { valid: false, error: "tool input must be an object" };
  }

  if (!isNonEmptyString(input.report_summary)) {
    return {
      valid: false,
      error: "report_summary is required and must be a non-empty string",
    };
  }

  if (!isNonEmptyString(input.boss_comment)) {
    return {
      valid: false,
      error: "boss_comment is required and must be a non-empty string",
    };
  }

  if (!isNonEmptyString(input.carry_over)) {
    return {
      valid: false,
      error: "carry_over is required and must be a non-empty string",
    };
  }

  return {
    valid: true,
    data: {
      reportSummary: input.report_summary,
      bossComment: input.boss_comment,
      carryOver: input.carry_over,
    },
  };
}
