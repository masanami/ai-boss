/**
 * 日付文字列が「暦として妥当な ISO 8601 の日付／日時」かを、`Date` に解釈させる
 * **前に**判定する共有述語。
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
 * ため成立しない。暦日の判定も**ローカル時刻の `Date` 往復では TZ 依存になる**
 * （`Pacific/Apia` は 2011-12-30 を丸ごとスキップしたため、その TZ では実在する
 * 日付が弾かれる。年 0〜99 も `Date` コンストラクタが 1900 年代へ写す）。そこで
 * 月の日数を `Date.UTC` から導き、成分の範囲比較だけで判定する。
 *
 * 本モジュールは `boss/persona-prompt.ts` の private ヘルパだった実装を、
 * 入力バリデーションからも使えるよう共有化したもの（同ファイルは本モジュールを
 * import する）。重複した 3 つ目の写しを作らないための集約である。
 */

/** 日付のみの値（`2026-09-05`）。web の日付入力から入る形 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 完全な ISO 8601 日時: `T` 区切り・分まで必須・秒/ミリ秒任意・タイムゾーン
 * 指定（`Z` または `±HH:MM`）任意。オフセットは**範囲を検査するために捕獲する**
 * — `+24:00` / `+09:60` は形だけ整っていて `new Date()` が `NaN` を返すため、
 * 捕獲せず素通しすると本述語が塞ごうとした穴がそのまま残る（Codex 指摘
 * design-1 / code-1）。
 */
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))?$/;

/**
 * `year` 年 `month` 月（1 始まり）の日数。閏年もこれで正しく出る。
 *
 * `Date.UTC(year, ...)` を直接使わないのは、年 0〜99 を 1900 年代へ写す仕様が
 * あるため（`Date.UTC(0, 2, 0)` は 1900 年 2 月末＝28 日を返し、閏年である
 * 西暦 0 年の `0000-02-29` を誤って弾く。Codex 指摘 code-1）。いったん安全な年で
 * 構築してから `setUTCFullYear` で年を入れ直すと、この写像を回避できる。
 */
function daysInMonth(year: number, month: number): number {
  const probe = new Date(Date.UTC(2000, month, 0));
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

/** 年月日が暦として実在するか（TZ 非依存） */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  );
}

/**
 * 文字列が「暦として妥当な ISO 8601 **日時**」か（日付のみは受理しない）。
 * 表示整形など、時刻を持つ値だけを対象にしたい呼び出し側が使う。
 */
export function isValidIsoDateTime(value: string): boolean {
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
  const offsetHour = matched[7] === undefined ? 0 : Number(matched[7]);
  const offsetMinute = matched[8] === undefined ? 0 : Number(matched[8]);

  return (
    isRealCalendarDate(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

/**
 * `YYYY-MM-DD`（日付のみ）または完全な ISO 8601 日時で、かつ暦として実在する
 * 日付・範囲内の時刻／オフセットであれば `true`。`due_at` は web の日付入力が
 * `YYYY-MM-DD` を、ボスの `create_task` / `update_task` が ISO 8601 日時を
 * 送るため、両方を受理する必要がある。
 */
export function isValidIsoDateOrDateTime(value: string): boolean {
  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return isRealCalendarDate(year, month, day);
  }

  return isValidIsoDateTime(value);
}
