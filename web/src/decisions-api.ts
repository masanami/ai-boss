import type { AppealSubmitResult, DecisionWithAppeals } from "./decision";

const DECISIONS_URL = "/api/decisions";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Fetches the decision log (newest first) from the backend, each decision
 * with its appeal history attached. Throws when the response is not ok so
 * callers can distinguish success from failure.
 */
export async function fetchDecisions(): Promise<DecisionWithAppeals[]> {
  const response = await fetch(DECISIONS_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as DecisionWithAppeals[];
}

/**
 * Submits a user's appeal against an active decision and returns the boss's
 * verdict. Throws with the server-provided error message on failure (e.g.
 * the decision is no longer active, or a Claude-side error).
 */
export async function submitAppeal(
  decisionId: number,
  content: string,
): Promise<AppealSubmitResult> {
  const response = await fetch(`${DECISIONS_URL}/${decisionId}/appeals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as AppealSubmitResult;
}
