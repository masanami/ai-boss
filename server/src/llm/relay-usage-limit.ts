/**
 * 中継の上限到達（機能仕様 docs/features/llm-relay-server.md「アプリ側の接続（S2）」
 * 決定 S2-Q6・仮定 A17・A18）: 失敗の値・上限が戻る時刻の計算・チャットへ出す案内の文言。
 *
 * このモジュールは製品版のコアのバンドル検査の対象（`core-entry.ts` から到達する）——
 * Node 組み込み・SDK を import しない（`Intl` は JS 標準）。
 */

/** 中継の 429 `usage_limit_exceeded` の `error.limit`。日・月以外（無い・未知の値）は `unknown`。 */
export type RelayUsageLimit = "daily" | "monthly" | "unknown";

/**
 * 中継の利用量の上限（日・月）に達したときの失敗。再試行不可。`message` は固定の文言
 * ——応答の本文・ライセンストークン・モデル ID を含めない。
 */
export class RelayUsageLimitError extends Error {
  readonly limit: RelayUsageLimit;

  constructor(limit: RelayUsageLimit) {
    super("LLM relay usage limit exceeded");
    this.name = "RelayUsageLimitError";
    this.limit = limit;
  }
}

/**
 * 上限が戻る時刻。中継の期間キー（UTC の暦日・暦月。仮定 A5）の境界と同じ:
 * 日は「`now` より後の最初の UTC の 0 時」、月は「`now` より後の最初の UTC の暦月の
 * 1 日 0 時」。境界ちょうどは次の境界。`unknown` は求められないので `null`。
 */
export function usageLimitResetAt(now: Date, limit: RelayUsageLimit): Date | null {
  switch (limit) {
    case "daily":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    case "monthly":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    case "unknown":
      return null;
  }
}

/** `{M}月{D}日 {H}:{mm}`（24 時間制・年は出さない）。環境の既定の並び・`24:00` に依存しない。 */
function formatResetTime(at: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("month")}月${value("day")}日 ${value("hour")}:${value("minute")}`;
}

/**
 * チャットの応答が上限到達で終わったときの案内の文言。日・月は上限が戻る時刻を
 * `timeZone`（省略時は端末の時間帯）で添える。BYOK・上位プランは勧めない。
 */
export function describeUsageLimitReached(limit: RelayUsageLimit, now: Date, timeZone?: string): string {
  const resetAt = usageLimitResetAt(now, limit);
  if (resetAt === null) {
    return "利用の上限に達しました。";
  }
  const period = limit === "daily" ? "1 日" : "1 か月";
  return `${period}の利用の上限に達しました。${formatResetTime(resetAt, timeZone)}に戻ります。`;
}
