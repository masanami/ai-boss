/**
 * 日付を YYYY-MM-DD 形式の日付キーに変換する。日報の「当日」判定に使う
 * （Issue #110）。
 *
 * `timeZone` を省略した場合はブラウザのローカルタイムゾーンの暦日（従来の
 * 挙動。既存の呼び出し箇所は無改修で通る）。IANA タイムゾーン名（例
 * "Asia/Tokyo"）を渡すと、そのタイムゾーンでの暦日に変換する
 * （Issue #304）。**本番コードの呼び出し箇所（use-daily-reports.ts /
 * use-work-log.ts）はこの第2引数を渡さない**——ADR 0007 決定1が「当日」は
 * 常にローカルタイムゾーンの暦日と定めているため。第2引数は主に、UTC /
 * 非UTC の両方で契約が守られていることをテストから直接検証するための
 * 注入点である。
 *
 * サーバー側にも `toDateKey`（server/src/detection/time-utils.ts）があり、
 * 第1引数（Date）・返り値（YYYY-MM-DD）は共通。第2引数の timeZone は本
 * Issue 時点では web 側のみの対応で、server 側への追加は別チケット
 * （#303）が担う。web と server は実行環境が異なりモジュールを共有する
 * 仕組みが無いため、揃えるのはインターフェースのみで実装はあえて別々に
 * 保つ（ADR 0007 決定 2）。
 *
 * `toISOString()` は常に UTC の暦日を返してしまい `timeZone` 引数を無視する
 * ことになるため使わない。`timeZone` を渡された場合のみ
 * `Intl.DateTimeFormat` で暦日の各要素を取り出して組み立てる
 * （`format()` 1発の文字列はロケール依存の区切り文字を含むため使わない）。
 *
 * 省略時の経路を `Intl` に寄せず従来のまま残しているのは、**本番の呼び出し
 * 箇所はすべて省略時の経路しか通らない**ため。注入点を足すために本番経路の
 * 実装を差し替えると、`Invalid Date` の扱い（従来は "NaN-NaN-NaN" を返す）
 * のような周辺の挙動まで巻き添えで変わる。server 側（time-utils.ts）も
 * 同じ形にしてある。
 */
export function toDateKey(date: Date, timeZone?: string): string {
  if (timeZone === undefined) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
}
