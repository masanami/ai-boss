export interface DailyReport {
  id: number;
  date: string;
  content: string;
  evening_session_id: number;
  created_at: string;
  updated_at: string;
}

/**
 * Shape returned by `GET /api/reports` (list view): date and timestamps
 * only, no `content`.
 */
export interface DailyReportSummary {
  date: string;
  created_at: string;
  updated_at: string;
}
