/**
 * Builds an `occurred_at` ISO string (#243 判断0・仮定1) for the given
 * `HH:mm` time-of-day input, anchored to today's local calendar date (仮定5:
 * the time input is time-only since the value can only be within today).
 * Returns null for an incomplete/invalid `HH:mm` value (the browser
 * `<input type="time">` only ever emits "" or a complete "HH:mm", so this is
 * a defensive fallback rather than the expected path).
 */
export function buildOccurredAtIso(hhmm: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  ).toISOString();
}

/**
 * Whether the given ISO datetime is strictly after the current time.
 */
export function isFutureIso(iso: string): boolean {
  return new Date(iso).getTime() > Date.now();
}
