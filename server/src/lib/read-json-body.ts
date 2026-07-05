import type { Context } from "hono";

/**
 * Parses the request body as JSON, returning `undefined` (rather than
 * throwing) when the body is missing or not valid JSON. Callers treat
 * `undefined` as a validation failure (400).
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
