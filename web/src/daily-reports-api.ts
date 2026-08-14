import type { DailyReport, DailyReportSummary } from "./daily-report";

const REPORTS_URL = "/api/reports";

/**
 * Thrown by the daily-report API client functions on a non-ok response.
 * Unlike `decisions-api.ts`'s `toErrorMessage` (which discards the server's
 * `code` and produces a plain `Error`), the daily-report UI must branch on
 * the stable `code` the backend attaches (e.g. `evening_session_required`,
 * `report_not_found`) rather than the Japanese message text (Issue #110
 * constraint), so this error keeps `code` alongside `message`. `code` is
 * `undefined` when the server didn't provide one (e.g. an unexpected 500).
 */
export class ReportApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "ReportApiError";
    this.code = code;
  }
}

async function toReportApiError(response: Response): Promise<ReportApiError> {
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    return new ReportApiError(
      body.error ?? `request failed with status ${response.status}`,
      body.code,
    );
  } catch {
    return new ReportApiError(
      `request failed with status ${response.status}`,
      undefined,
    );
  }
}

/**
 * Fetches the daily report list (newest first, date/timestamps only) from
 * the backend. Throws a `ReportApiError` when the response is not ok.
 */
export async function fetchDailyReportSummaries(): Promise<
  DailyReportSummary[]
> {
  const response = await fetch(REPORTS_URL);
  if (!response.ok) {
    throw await toReportApiError(response);
  }
  return (await response.json()) as DailyReportSummary[];
}

/**
 * Fetches the full report (with content) for the given local date key
 * (`YYYY-MM-DD`). Throws a `ReportApiError` with `code: "report_not_found"`
 * when no report exists for that date (404).
 */
export async function fetchDailyReport(date: string): Promise<DailyReport> {
  const response = await fetch(`${REPORTS_URL}/${date}`);
  if (!response.ok) {
    throw await toReportApiError(response);
  }
  return (await response.json()) as DailyReport;
}

/**
 * Generates (or re-generates, upserting the same-day row) today's daily
 * report. Throws a `ReportApiError` with
 * `code: "evening_session_required"` when the day's evening session hasn't
 * been completed yet (409).
 */
export async function generateDailyReport(): Promise<DailyReport> {
  const response = await fetch(`${REPORTS_URL}/generate`, {
    method: "POST",
  });
  if (!response.ok) {
    throw await toReportApiError(response);
  }
  return (await response.json()) as DailyReport;
}
