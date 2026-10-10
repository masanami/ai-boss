import type {
  Settings,
  SettingsPatch,
  UpdateSettingsResult,
} from "./settings";

const SETTINGS_URL = "/api/settings";

async function toErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `request failed with status ${response.status}`;
  } catch {
    return `request failed with status ${response.status}`;
  }
}

/**
 * Fetches the current effective settings from the backend. Throws when the
 * response is not ok so callers can distinguish success from failure.
 */
export async function fetchSettings(): Promise<Settings> {
  const response = await fetch(SETTINGS_URL);
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  return (await response.json()) as Settings;
}

/**
 * Applies a partial update to the settings and returns the resulting
 * effective settings together with the save's warnings (#708 決定 18 — the
 * 200 body is `{ settings, warnings }`). Throws with the server-provided
 * error message when validation fails (e.g. an out-of-range value) — the
 * caller keeps the previous state in that case (see `useSettings`).
 */
export async function updateSettings(
  patch: SettingsPatch,
): Promise<UpdateSettingsResult> {
  const response = await fetch(SETTINGS_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(await toErrorMessage(response));
  }
  const { settings, warnings } =
    (await response.json()) as UpdateSettingsResult;
  return { settings, warnings };
}
