import type Database from "better-sqlite3";

interface SettingRow {
  value: string | null;
}

/**
 * Reads a single value from the `settings` key-value table. Returns
 * `undefined` when the key is not set, so callers can apply their own
 * default (see `boss/boss-settings.ts`).
 *
 * Minimal read helper for this ticket (#27). A fuller settings module
 * (get-all / put) is expected to land with the settings screen (#8).
 */
export function getSettingValue(
  db: Database.Database,
  key: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as SettingRow | undefined;

  return row?.value ?? undefined;
}
