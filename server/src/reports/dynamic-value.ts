// 動的値（タスク名・決定の content・LLM が返す4値 等）を Markdown へ埋め込む
// 前に適用する正規化・エスケープ。固定構造を壊さないための契約
// (docs/features/daily-report.md「動的値のエスケープ・正規化」)。日報
// （render-daily-report.ts）・作業ログ（render-work-log.ts）の両レンダラーが
// 共用する。

/** 改行 (CR/LF/CRLF) を半角空白へ置換する */
const NEWLINE_PATTERN = /\r\n|\r|\n/g;
/** 2つ以上連続する半角空白を1つに畳む */
const CONSECUTIVE_SPACES_PATTERN = / {2,}/g;

/** 値の先頭が構造を壊す単一文字のMarkdown記号のとき */
const LEADING_SYMBOL_PATTERN = /^[#\-*+>|]/;
/** 値の先頭が "1." 形式の番号のとき（番号部分をキャプチャし、ピリオドの直前にのみ
 *  バックスラッシュを挿入する。番号自体は視認性のため残す） */
const LEADING_NUMBERED_PATTERN = /^(\d+)\./;

/**
 * 1行への正規化（改行→半角空白・連続空白の畳み込み・前後trim）に続けて、
 * 値の先頭に来ると構造を壊すMarkdown記号（# - * + > | および "1." 形式の番号）
 * をバックスラッシュでエスケープする。
 */
export function normalizeDynamicValue(value: string): string {
  const singleLine = value
    .replace(NEWLINE_PATTERN, " ")
    .replace(CONSECUTIVE_SPACES_PATTERN, " ")
    .trim();

  if (LEADING_SYMBOL_PATTERN.test(singleLine)) {
    return `\\${singleLine}`;
  }

  const numberedMatch = singleLine.match(LEADING_NUMBERED_PATTERN);
  if (numberedMatch) {
    const [fullMatch, digits] = numberedMatch;
    return `${digits}\\.${singleLine.slice(fullMatch.length)}`;
  }

  return singleLine;
}
