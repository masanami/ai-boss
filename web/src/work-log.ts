/**
 * 作業ログ（管理者共有向け・Issue #161）。サーバーの
 * `GET /api/work-logs/:date` のレスポンス形状。
 * 保存されないため作成・更新日時は持たない。
 */
export interface WorkLog {
  /** ローカル日付キー（YYYY-MM-DD） */
  date: string;
  /** 作業ログ Markdown 全文 */
  content: string;
}
