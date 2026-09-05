/**
 * Builds an `occurred_at` ISO string (#243 判断0・仮定1) for the given
 * `HH:mm` time-of-day input, anchored to today's local calendar date (仮定5:
 * the time input is time-only since the value can only be within today).
 * Returns null for an incomplete/invalid `HH:mm` value (the browser
 * `<input type="time">` only ever emits "" or a complete "HH:mm", so this is
 * a defensive fallback rather than the expected path) **and for a wall-clock
 * time that does not exist on today's local date** (DST spring-forward gap).
 * Callers must treat a non-empty input that yields null as an input error,
 * not as "no time given".
 */
export function buildOccurredAtIso(hhmm: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  const now = new Date();
  const date = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  );
  // 往復検証（Codex 指摘 PR #357）: 夏時間の切り替えで存在しない現地時刻
  // （例: America/New_York の 2026-03-08 02:30）は Date コンストラクタが
  // 黙って 03:30 へ丸めるため、そのまま送るとサーバには別の時刻が保存される
  // のに成功メッセージは入力どおりに出る。生成した Date の現地時・分が入力と
  // 一致しなければ「存在しない時刻」として null を返し、呼び出し側が入力
  // エラーとして扱う。
  if (date.getHours() !== hours || date.getMinutes() !== minutes) {
    return null;
  }
  return date.toISOString();
}

/**
 * Whether the given ISO datetime is strictly after the current time.
 */
export function isFutureIso(iso: string): boolean {
  return new Date(iso).getTime() > Date.now();
}
