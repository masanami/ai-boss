import { useCallback, useEffect, useState } from "react";
import { fetchDecisions, submitAppeal } from "./decisions-api";
import type { AppealSubmitResult, DecisionWithAppeals } from "./decision";

export type DecisionsLoadStatus = "loading" | "ready" | "error";

export interface UseDecisionsResult {
  decisions: DecisionWithAppeals[];
  status: DecisionsLoadStatus;
  appeal: (decisionId: number, content: string) => Promise<AppealSubmitResult>;
}

/**
 * Loads the decision log on mount and exposes an action to submit an appeal.
 * Mirrors the fetch-on-mount pattern used by `useTasks`. Per the ticket's
 * explicit assumption, any appeal submission (upheld or revised) simply
 * re-fetches the full list rather than merging the result locally (KISS).
 */
export function useDecisions(): UseDecisionsResult {
  const [decisions, setDecisions] = useState<DecisionWithAppeals[]>([]);
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

  const appeal = useCallback(
    async (decisionId: number, content: string) => {
      const result = await submitAppeal(decisionId, content);
      const refreshed = await fetchDecisions();
      setDecisions(refreshed);
      return result;
    },
    [],
  );

  return { decisions, status, appeal };
}
