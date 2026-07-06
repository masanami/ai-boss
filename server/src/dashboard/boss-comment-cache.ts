import type Database from "better-sqlite3";
import { getSettingValue } from "../settings/settings-repository.js";

/**
 * ボスの今日のひとことの日次キャッシュ（Issue #58）。`settings` テーブルに
 * 2キー（日付・本文）で保存する。
 *
 * 並行チケット #57（設定 API）が `settings-repository.ts` に
 * `setSettingValue` を追加中のため、競合を避けてこのモジュール内に
 * ローカルな upsert ヘルパーを置く（settings-repository.ts は変更しない —
 * 明示的な仮定）。
 * TODO(#57マージ後): `upsertSettingValue` を `settings-repository.ts` の
 * `setSettingValue` に置き換えて統合する（重複実装の解消）。
 *
 * 注意: この2キーは人格・モデル設定ではなく派生キャッシュのため、将来
 * `GET /api/settings`（設定一覧取得、#8/#57）を実装する際は表示対象から
 * 除外すること（ユーザー設定と誤認させないため）。
 */

const DASHBOARD_COMMENT_DATE_KEY = "dashboard_comment_date";
const DASHBOARD_COMMENT_TEXT_KEY = "dashboard_comment_text";

function upsertSettingValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * `todayKey`（ローカル日付 `YYYY-MM-DD`）に一致するキャッシュがあればその
 * 本文を返す。キャッシュが無い、または別日のキャッシュの場合は `undefined`。
 */
export function getCachedBossComment(
  db: Database.Database,
  todayKey: string,
): string | undefined {
  const cachedDate = getSettingValue(db, DASHBOARD_COMMENT_DATE_KEY);
  if (cachedDate !== todayKey) {
    return undefined;
  }
  return getSettingValue(db, DASHBOARD_COMMENT_TEXT_KEY);
}

/** `todayKey` に対する本文をキャッシュに保存する（既存キャッシュを上書き）。 */
export function setCachedBossComment(
  db: Database.Database,
  todayKey: string,
  comment: string,
): void {
  upsertSettingValue(db, DASHBOARD_COMMENT_DATE_KEY, todayKey);
  upsertSettingValue(db, DASHBOARD_COMMENT_TEXT_KEY, comment);
}
