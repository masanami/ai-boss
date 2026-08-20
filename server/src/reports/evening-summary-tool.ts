// 日報生成の「値の抽出」段（収集 → 値の抽出 → レンダリング → 保存 の4段の
// うち2段目。docs/adr/0006-renderer-owns-structure.md）で使うツール定義。
//
// `server/src/decisions/verdict-tool.ts` に倣い、JSON Schema ＋ 入力バリデータ
// を1ファイルにまとめる。LLM に Markdown を組み立てさせない
// （ADR 0006 決定 2）ため、ツールが要求するのは「報告の要点」
// 「ボスの講評」「決定の要点」「翌日への持ち越し」の4つの**値**のみで、
// 見出し・箇条書き記法などの構造は一切含めない。「決定の要点」は Issue #144
// （日報「決定事項」セクションの廃止・夕会サマリへの統合）で追加した。
import type Anthropic from "@anthropic-ai/sdk";
import type { EveningSummaryValues } from "./render-daily-report.js";

export const SUBMIT_EVENING_SUMMARY_TOOL: Anthropic.Tool = {
  name: "submit_evening_summary",
  description:
    "夕会（報告セッション）の会話ログと当日の決定一覧から「報告の要点」「ボスの講評」「決定の要点」「翌日への持ち越し」の4つの値を抽出して提出する。" +
    "Markdown の見出し・箇条書き記号・装飾は使わず、それぞれ簡潔な平文（1〜2文程度）で書くこと。" +
    "決定の要点が無い場合は key_decisions に、翌日への持ち越しが無い場合は carry_over に、それぞれ「なし」と明記すること（省略・空文字は不可）。",
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
      key_decisions: {
        type: "string",
        description:
          "当日の決定のうち最終状態として効いているもの（確定ノルマ・新規タスク登録・持ち越し判断等）の要約。" +
          "該当が無い場合は「なし」と書くこと（空文字は不可）。",
      },
      carry_over: {
        type: "string",
        description:
          "翌日への持ち越し事項の要約。持ち越しが無い場合は「なし」と書くこと（空文字は不可）。",
      },
    },
    required: ["report_summary", "boss_comment", "key_decisions", "carry_over"],
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
 * （保証 G-170-49 — 形式不正はフォールバック経路へ倒す）。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `submit_evening_summary` の tool_use 入力を検証する。4値はすべて必須かつ
 * 空文字不可（`parseVerdictToolInput` と同じ厳格さ）。1つでも欠落・空文字
 * があれば `valid: false` を返し、呼び出し側（抽出ステップ）はこれを
 * 「不正形」としてフォールバック（4値なし）へ倒す。
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

  if (!isNonEmptyString(input.key_decisions)) {
    return {
      valid: false,
      error: "key_decisions is required and must be a non-empty string",
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
      keyDecisions: input.key_decisions,
      carryOver: input.carry_over,
    },
  };
}
