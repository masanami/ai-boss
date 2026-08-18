import { ReportApiError } from "./daily-reports-api";
import type { WorkLog } from "./work-log";

const WORK_LOGS_URL = "/api/work-logs";

/**
 * Fetches the work log (admin-shareable chronological Markdown, generated
 * on demand server-side) for the given local date key (`YYYY-MM-DD`).
 *
 * Reuses `ReportApiError` from `daily-reports-api.ts`: the work-log API
 * follows the same `{ error, code }` contract (docs/features/work-log.md
 * 「エラー形式」), and the UI branches on the stable `code` (e.g.
 * `invalid_date`) the same way the daily-report UI does.
 */
export async function fetchWorkLog(date: string): Promise<WorkLog> {
  const response = await fetch(`${WORK_LOGS_URL}/${date}`);
  if (!response.ok) {
    let body: { error?: string; code?: string };
    try {
      body = (await response.json()) as { error?: string; code?: string };
    } catch {
      throw new ReportApiError(
        `request failed with status ${response.status}`,
        undefined,
      );
    }
    throw new ReportApiError(
      body.error ?? `request failed with status ${response.status}`,
      body.code,
    );
  }
  return (await response.json()) as WorkLog;
}
