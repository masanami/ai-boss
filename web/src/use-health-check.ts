import { useEffect, useState } from "react";

export type HealthStatus = "checking" | "connected" | "disconnected";

const HEALTH_CHECK_URL = "/api/health";

/**
 * Fetches the backend health endpoint on mount and reports the connection
 * status. Network failures and non-ok responses are both treated as
 * "disconnected" so the app never crashes when the server is unavailable.
 */
export function useHealthCheck(): HealthStatus {
  const [status, setStatus] = useState<HealthStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    fetch(HEALTH_CHECK_URL)
      .then((response) => {
        if (!cancelled) {
          setStatus(response.ok ? "connected" : "disconnected");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("disconnected");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
