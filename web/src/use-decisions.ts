import { useEffect, useState } from "react";
import { fetchDecisions } from "./decisions-api";
import type { DecisionRecord } from "./decision";

export type DecisionsLoadStatus = "loading" | "ready" | "error";

export interface UseDecisionsResult {
  decisions: DecisionRecord[];
  status: DecisionsLoadStatus;
}

/**
 * Loads the decision log on mount. Mirrors the fetch-on-mount pattern used by
 * `useTasks`. Read-only: the appeals submission path was removed with the
 * appeals feature (#358/#397) — re-litigating a decision now happens in chat,
 * where the boss's `record_decision` tool records a new decision.
 */
export function useDecisions(): UseDecisionsResult {
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [status, setStatus] = useState<DecisionsLoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;

    fetchDecisions()
      .then((fetched) => {
        if (!cancelled) {
          setDecisions(fetched);
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

  return { decisions, status };
}
