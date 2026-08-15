/**
 * ローカル日付を YYYY-MM-DD 形式で返す。サーバー側の `toDateKey`
 * （server/src/detection/time-utils.ts）と同じ基準（ブラウザのローカル
 * タイムゾーンの暦日）。日報の「当日」判定に使う（Issue #110）。
 */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
