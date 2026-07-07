import { useEffect, useState } from "react";
import { fetchDashboard } from "./dashboard-api";
import type { DashboardResponse } from "./dashboard-response";

export type DashboardLoadStatus = "loading" | "ready" | "error";

export interface UseDashboardResult {
  dashboard: DashboardResponse | null;
  status: DashboardLoadStatus;
}

/**
 * Loads the dashboard summary on mount. Mirrors the fetch-on-mount pattern
 * used by `useTasks` / `useDecisions`. There is no mutating action here (the
 * dashboard is read-only), so unlike those hooks this only exposes the
 * loaded data and status.
 */
export function useDashboard(): UseDashboardResult {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [status, setStatus] = useState<DashboardLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    fetchDashboard()
      .then((fetched) => {
        if (!cancelled) {
          setDashboard(fetched);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { dashboard, status };
}
