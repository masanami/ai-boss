import type Database from "better-sqlite3";
import {
  getSettingValue,
  setSettingValue,
} from "../settings/settings-repository.js";

/**
 * ボスの今日のひとことの日次キャッシュ（Issue #58）。`settings` テーブルに
 * 2キー（日付・本文）で保存する。
 *
 * 注意: この2キーは人格・モデル設定ではなく派生キャッシュのため、
 * `GET /api/settings`（設定一覧取得、#8/#57）の表示対象から除外すること
 * （ユーザー設定と誤認させないため）。
 */

const DASHBOARD_COMMENT_DATE_KEY = "dashboard_comment_date";
const DASHBOARD_COMMENT_TEXT_KEY = "dashboard_comment_text";

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
  setSettingValue(db, DASHBOARD_COMMENT_DATE_KEY, todayKey);
  setSettingValue(db, DASHBOARD_COMMENT_TEXT_KEY, comment);
}
