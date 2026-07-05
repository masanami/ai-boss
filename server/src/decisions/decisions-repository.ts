import type Database from "better-sqlite3";
import type { RecentDecision } from "../boss/persona-prompt.js";

interface DecisionRow {
  content: string;
  created_at: string;
}

/**
 * Returns the most recent `limit` decisions (created_at descending), mapped
 * to the shape `buildPersonaPrompt` expects (`decidedAt`).
 *
 * Read-only helper for chat context building (#27). Writing decisions
 * (recording a boss decision) is out of scope here — see Issue #6.
 */
export function listRecentDecisions(
  db: Database.Database,
  limit: number,
): RecentDecision[] {
  const rows = db
    .prepare(
      "SELECT content, created_at FROM decisions ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as DecisionRow[];

  return rows.map((row) => ({
    content: row.content,
    decidedAt: row.created_at,
  }));
}
