import type { DecisionRecord } from "./decision";

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
 * Fetches the decision log (newest first) from the backend as a flat list.
 * Grouping into task sections is the renderer's job (#358 判断5). Throws when
 * the response is not ok so callers can distinguish success from failure.
 */
export async function fetchDecisions(): Promise<DecisionRecord[]> {
  const response = await fetch(DECISIONS_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as DecisionRecord[];
}
