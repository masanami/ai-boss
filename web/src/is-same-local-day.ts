/**
 * Whether two timestamps fall on the same calendar day in the browser's
 * local timezone. Used to decide whether a session (adhoc/morning/evening)
 * started earlier is still "today's" session or should be treated as stale.
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
