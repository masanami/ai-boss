import type { Db } from "../db/db-port.js";

interface SettingRow {
  value: string | null;
}

interface SettingKeyValueRow {
  key: string;
  value: string | null;
}

/**
 * A consistent, point-in-time view of the whole `settings` key-value table.
 * Keys whose stored value is `NULL` are absent, the same as keys that were
 * never set (callers apply their own default — see `boss/boss-settings.ts`).
 *
 * Why a snapshot (#603・Issue #597 のコメント P2): once the DB is reached
 * through the async port, every separate `await db.get(...)` releases the
 * serialization lock between queries, so a helper that reads several keys
 * one by one could observe a concurrent `PUT /api/settings` commit halfway
 * through and return a mix of old and new values that never existed together
 * in the DB. Reading every key in one `SELECT` makes the view atomic without
 * holding a transaction open.
 */
export type SettingsSnapshot = ReadonlyMap<string, string>;

/**
 * Reads the whole `settings` table as one {@link SettingsSnapshot} (a single
 * statement, so it can never interleave with another flow's writes).
 */
export async function readSettingsSnapshot(db: Db): Promise<SettingsSnapshot> {
  const rows = await db.all<SettingKeyValueRow>("SELECT key, value FROM settings");
  const snapshot = new Map<string, string>();
  for (const row of rows) {
    if (row.value !== null) {
      snapshot.set(row.key, row.value);
    }
  }
  return snapshot;
}

/**
 * Reads a single value from the `settings` key-value table. Returns
 * `undefined` when the key is not set, so callers can apply their own
 * default (see `boss/boss-settings.ts`). Prefer {@link readSettingsSnapshot}
 * when several keys must be read together.
 */
export async function getSettingValue(db: Db, key: string): Promise<string | undefined> {
  const row = await db.get<SettingRow>("SELECT value FROM settings WHERE key = ?", [key]);

  return row?.value ?? undefined;
}

/**
 * Upserts a single value into the `settings` key-value table. Passing
 * `null` stores a NULL `value` column, which makes {@link getSettingValue}
 * return `undefined` for that key afterwards (same as if the key had never
 * been set) — this is how callers (see `settings/settings-routes.ts`)
 * implement "reset to default" for keys such as `boss_custom_instructions`
 * without needing a separate delete helper.
 */
export async function setSettingValue(db: Db, key: string, value: string | null): Promise<void> {
  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
