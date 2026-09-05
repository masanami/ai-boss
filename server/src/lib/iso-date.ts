/**
 * 日付文字列が「暦として妥当な ISO 8601 の日付または日時」かを、`Date` に
 * 解釈させる**前に**判定する共有述語。
 *
 * `new Date()` は存在しない日付を黙ってロールオーバーさせ（`2026-02-30` →
 * 3/2）、`"0"` や `"12/31/2026"` のような非 ISO 文字列も受理する。
 * `Number.isNaN(getTime())` のガードだけでは不正値が保存され、下流で実害に
 * なる: `detection/deadline-overdue.ts` は `new Date(due_at).getTime()` を
 * `now` と比較するため `NaN` の締切は**永久に期限超過と判定されず**、
 * `detection/priority.ts` の `dueAtRank` も `NaN` を並び順へ混入させる。
 *
 * 判定は `Date` を介さず文字列の構成要素に対して行う。parse 後のローカル成分と
 * 突き合わせる方式は、オフセット付きの値だと実行環境の TZ 次第で成分がずれる
 * ため成立しない（`boss/persona-prompt.ts` の `isValidIsoDateTime` と同じ理由・
 * 同じ作法。あちらは表示整形のための private ヘルパで、本モジュールは入力
 * バリデーション用の共有版）。
 */

/** 日付のみの値（`2026-09-05`）。web の日付入力から入る形 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 完全な ISO 8601 日時: `T` 区切り・分まで必須・秒/ミリ秒任意・タイムゾーン
 * 指定（`Z` または `±HH:MM`）任意。`boss/activity-log-tool.ts` /
 * `boss/persona-prompt.ts` の同種パターンと同じ緩さに揃えてある。
 */
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * `2026-02-30` のような存在しない暦日を弾く。`Date` の月繰り上げ正規化を
 * 逆手に取り、構成要素が往復して一致するかで判定する。
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year &&
    probe.getMonth() === month - 1 &&
    probe.getDate() === day
  );
}

/**
 * `YYYY-MM-DD`（日付のみ）または完全な ISO 8601 日時で、かつ暦として実在する
 * 日付・範囲内の時刻であれば `true`。
 */
export function isValidIsoDateOrDateTime(value: string): boolean {
  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return isRealCalendarDate(year, month, day);
  }

  const matched = ISO_DATE_TIME_PATTERN.exec(value);
  if (matched === null) {
    return false;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const hour = Number(matched[4]);
  const minute = Number(matched[5]);
  const second = matched[6] === undefined ? 0 : Number(matched[6]);

  if (!isRealCalendarDate(year, month, day)) {
    return false;
  }

  return hour <= 23 && minute <= 59 && second <= 59;
}
