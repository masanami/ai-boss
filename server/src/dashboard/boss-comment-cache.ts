import type Database from "better-sqlite3";
import {
  getSettingValue,
  setSettingValue,
} from "../settings/settings-repository.js";

/**
 * ボスの今日のひとことの日次キャッシュ（Issue #58、フィンガープリント方式を
 * Issue #121 で追加）。`settings` テーブルに3キー（日付・タスク状態
 * フィンガープリント・本文）で保存する。
 *
 * フィンガープリントは `task-fingerprint.ts` の `computeTaskFingerprint` が
 * `listTasks(db)` の結果から算出する `(id, updated_at)` 射影のハッシュ。
 * 日付だけでは同日中のタスク作成・更新に反応できず「タスクが空」前提の
 * 古いコメントが残ってしまう（#98）ため、日付とフィンガープリントの
 * **両方が一致したときだけ**キャッシュを有効とみなす。
 *
 * 注意: この3キーは人格・モデル設定ではなく派生キャッシュのため、
 * `GET /api/settings`（設定一覧取得、#8/#57）の表示対象から除外すること。
 * `settings-routes.ts` の `readEffectiveSettings()` は返却キーを明示列挙する
 * allowlist 方式であり、ここで追加したキーを列挙に加えない限り自動的には
 * 現れないため、追加の除外実装は不要（allowlist に触れないことがそのまま
 * 除外を意味する）。
 */

const DASHBOARD_COMMENT_DATE_KEY = "dashboard_comment_date";
const DASHBOARD_COMMENT_FINGERPRINT_KEY = "dashboard_comment_fingerprint";
const DASHBOARD_COMMENT_TEXT_KEY = "dashboard_comment_text";

/**
 * `todayKey`（ローカル日付 `YYYY-MM-DD`）と `fingerprint`（タスク状態の
 * フィンガープリント）の両方が一致するキャッシュがあればその本文を返す。
 * キャッシュが無い、日付が異なる、またはフィンガープリントが異なる場合は
 * `undefined`。
 */
export function getCachedBossComment(
  db: Database.Database,
  todayKey: string,
  fingerprint: string,
): string | undefined {
  const cachedDate = getSettingValue(db, DASHBOARD_COMMENT_DATE_KEY);
  const cachedFingerprint = getSettingValue(db, DASHBOARD_COMMENT_FINGERPRINT_KEY);
  if (cachedDate !== todayKey || cachedFingerprint !== fingerprint) {
    return undefined;
  }
  return getSettingValue(db, DASHBOARD_COMMENT_TEXT_KEY);
}

/**
 * `todayKey` と `fingerprint` に対する本文をキャッシュに保存する
 * （既存キャッシュを上書き）。3キーを `db.transaction` で1単位として書き込む
 * （`settings-routes.ts` の複数キー書き込みと同じ idiom）。これが無いと、
 * 3書き込みのうち2番目・3番目が失敗した場合に「日付とフィンガープリントは
 * 新しいが本文は古いまま」という状態が残り、次回読み出しがキャッシュヒット
 * 判定になって#98と同種の「古い文面を新しい状態のものとして返す」不整合を
 * 招く（自己レビューで指摘・修正）。
 */
export function setCachedBossComment(
  db: Database.Database,
  todayKey: string,
  fingerprint: string,
  comment: string,
): void {
  const applyUpdate = db.transaction(() => {
    setSettingValue(db, DASHBOARD_COMMENT_DATE_KEY, todayKey);
    setSettingValue(db, DASHBOARD_COMMENT_FINGERPRINT_KEY, fingerprint);
    setSettingValue(db, DASHBOARD_COMMENT_TEXT_KEY, comment);
  });
  applyUpdate();
}
