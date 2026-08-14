/** `GET /api/reports` の一覧要素（`content` を含まない。
 * docs/features/daily-report.md「レスポンススキーマ」）。 */
export interface DailyReportSummary {
  date: string;
  created_at: string;
  updated_at: string;
}

/** `GET /api/reports/:date` / `POST /api/reports/generate` の応答。 */
export interface DailyReport extends DailyReportSummary {
  id: number;
  content: string;
  evening_session_id: number;
}
