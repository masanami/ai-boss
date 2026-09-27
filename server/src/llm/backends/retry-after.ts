/**
 * `Retry-After`（RFC 9110 §10.2.3）の値をミリ秒へ解釈する、SDK に依存しない
 * 純粋関数（機能仕様 docs/features/secure-transport-byok.md 仮定 A13）。
 *
 * 元は `api-backend.ts`（`@anthropic-ai/sdk` の `APIError` から値を読む）に
 * だけ存在したロジックをそのまま切り出したもの——`api` バックエンドの
 * 挙動（`api-backend.test.ts`）は変えない。BYOK（Anthropic）のバックエンド
 * （`byok-anthropic-backend.ts`）は SDK を値 import できない
 * （製品版のコアのバンドル検査）ため、この純粋関数を共有する。
 */

/** RFC 9110 §5.6.7 IMF-fixdate —受け付ける唯一の日付形式（`api-backend.ts`
 * の元のコメントと同じ理由: `Date.parse` へ直接渡すと ISO 8601 等も緩く
 * 受理してしまい、`"-9999"` のような値が思わぬ形で解釈されうる）。 */
const RETRY_AFTER_HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `value`（`Retry-After` ヘッダの生の値）を `now` を基準にミリ秒へ解釈する。
 * 非負整数の秒数、または上記の正規表現に一致する HTTP 日付のみを受け付ける。
 * それ以外・過去の日付・空文字・`undefined`/`null` は `undefined`（「指定
 * なし」）を返す。
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  // 数値（秒）形式。RFC 9110 は非負整数のみを許容する。
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const milliseconds = seconds * 1000;
    // 有限性は積（milliseconds）側で確認する: seconds 自体は有限（例:
    // 1e306）でも `seconds * 1000` が Infinity へオーバーフローしうる。
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }

  // HTTP 日付形式（例: "Wed, 21 Oct 2026 07:28:00 GMT"）。
  if (!RETRY_AFTER_HTTP_DATE_RE.test(trimmed)) {
    return undefined;
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) {
    return undefined;
  }
  const waitMs = targetMs - now.getTime();
  return waitMs >= 0 ? waitMs : undefined;
}
