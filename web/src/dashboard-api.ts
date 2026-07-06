import type { DashboardResponse } from "./dashboard-response";

const DASHBOARD_URL = "/api/dashboard";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Fetches today's dashboard summary (progress, session flags, escalation
 * level, boss comment) from the backend. Throws when the response is not ok
 * so callers can distinguish success from failure.
 */
export async function fetchDashboard(): Promise<DashboardResponse> {
  const response = await fetch(DASHBOARD_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as DashboardResponse;
}
