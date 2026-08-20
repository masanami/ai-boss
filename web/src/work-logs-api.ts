import { ReportApiError } from "./daily-reports-api";
import type { WorkLog } from "./work-log";

const WORK_LOGS_URL = "/api/work-logs";

/**
 * Fetches the work log (admin-shareable chronological Markdown, generated
 * on demand server-side) for the given local date key (`YYYY-MM-DD`).
 *
 * Reuses `ReportApiError` from `daily-reports-api.ts`: the work-log API
 * follows the same `{ error, code }` contract (保証 G-170-44 /
 * G-170-113), so the stable `code` (e.g. `invalid_date`) is preserved on
 * the thrown error and is available to callers that need to branch on it.
 * The current work-log UI (`use-work-log.ts` / `WorkLogView.tsx`) only
 * surfaces the message and does not branch on `code` — unlike the
 * daily-report UI, which branches on `evening_session_required`.
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
