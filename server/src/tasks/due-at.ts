import { parseDateKey, toDateKey } from "../detection/time-utils.js";
import { startOfNextLocalDayIso } from "../activity/local-day.js";
import { isValidIsoDateOrDateTime } from "../lib/iso-date.js";

/**
 * `due_at` の値（日付のみ `YYYY-MM-DD`、または旧形式の時刻付き ISO 8601 日時）
 * を判別する。妥当性は呼び出し側が {@link isValidIsoDateOrDateTime} で確認済み
 * という前提（本モジュール内部専用のヘルパのため、未検証の値では呼ばない）。
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 妥当性検証済みの `due_at` 文字列を、その値が表す**ローカル暦日の
 * 00:00** を指す `Date` へ写す（ADR 0010 決定 3）。
 *
 * - 日付のみ（`YYYY-MM-DD`）: その暦日そのもの。`parseDateKey` へそのまま渡す。
 * - 時刻付き（旧形式）: その瞬時をローカルタイムゾーンで解釈した暦日
 *   （`new Date(dueAt)` で瞬時を得て `toDateKey` でローカル暦日キーへ変換し、
 *   `parseDateKey` でその暦日の 00:00 の `Date` に戻す）。文字列の先頭10文字を
 *   切り出す方法（オフセットが暦日をまたぐ値で誤った日になる）は使わない。
 *
 * 日付演算そのものは `detection/time-utils.ts` / `activity/local-day.ts` の
 * 既存の集約点に委ね、本関数はどちらの形式かを判別して橋渡しするだけに留める
 * （ADR 0010 決定 5: 日付演算を新規に書かない）。
 *
 * `parseDateKey` が `null` を返しうるため、戻り値も `null` を許す。
 * `isValidIsoDateOrDateTime` は TZ 非依存に「暦として実在するか」を見るのに対し、
 * `parseDateKey` はローカル `Date` の往復で検証するため、**実行 TZ が丸ごと
 * スキップした暦日**では両者の判定が割れる（`Pacific/Apia` は 2011-12-30 を
 * スキップしたため、その TZ では `isValidIsoDateOrDateTime("2011-12-30")` が
 * true でも `parseDateKey` は null を返す。`lib/iso-date.ts` の実装コメント参照）。
 * ここを非 null 断言で潰すと `startOfNextLocalDayIso(null)` が TypeError で
 * 落ちるため、`null` を素通しして呼び出し側で「締切なし」へ倒す（決定 6 と同じ
 * 倒し方に揃える）。
 */
function resolveDueAtLocalDay(dueAt: string): Date | null {
  if (DATE_ONLY_PATTERN.test(dueAt)) {
    return parseDateKey(dueAt);
  }
  const instant = new Date(dueAt);
  return parseDateKey(toDateKey(instant));
}

/**
 * 締切が切れる瞬時（epoch ミリ秒）を返す。
 *
 * ADR 0010 決定 2: 締切超過は「締切の暦日 `D` の翌ローカル暦日 `D+1` の
 * 00:00 を過ぎたとき」に成立する。`D+1` 00:00 ちょうどはまだ超過ではない
 * （半開区間 `[D+1 00:00, ...)` の下限＝この関数が返す瞬時そのものが境界）。
 *
 * `dueAt` が `null`、または {@link isValidIsoDateOrDateTime} を満たさない
 * （暦として解釈できない）場合は「締切なし」として `null` を返す
 * （ADR 0010 決定 6: この述語は広げない）。
 */
export function toDueAtInstant(dueAt: string | null): number | null {
  if (dueAt === null || !isValidIsoDateOrDateTime(dueAt)) {
    return null;
  }
  const localDay = resolveDueAtLocalDay(dueAt);
  if (localDay === null) {
    return null;
  }
  return new Date(startOfNextLocalDayIso(localDay)).getTime();
}

/**
 * `due_at` の書き込み時の正規化。ローカル暦日キー（`YYYY-MM-DD`）を返す。
 *
 * ADR 0010 決定 3・4: 旧形式（時刻付き）は不正値ではなく正規化対象として扱い、
 * その瞬時のローカル暦日へ落とす。`dueAt` が `null`、または
 * {@link isValidIsoDateOrDateTime} を満たさない場合は `null`（決定 6）。
 */
export function normalizeDueAtToDateKey(dueAt: string | null): string | null {
  if (dueAt === null || !isValidIsoDateOrDateTime(dueAt)) {
    return null;
  }
  const localDay = resolveDueAtLocalDay(dueAt);
  if (localDay === null) {
    return null;
  }
  return toDateKey(localDay);
}
