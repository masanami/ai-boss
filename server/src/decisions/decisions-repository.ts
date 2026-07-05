import type Database from "better-sqlite3";
import type { RecentDecision } from "../boss/persona-prompt.js";
import type { Decision } from "./decision.js";

interface DecisionRow {
  content: string;
  created_at: string;
}

export interface NewDecisionRecord {
  session_id: number;
  task_id?: number | null;
  content: string;
  rationale?: string | null;
}

export function findDecisionById(
  db: Database.Database,
  id: number,
): Decision | undefined {
  return db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
    | Decision
    | undefined;
}

/**
 * Inserts a new decision with a server-managed `created_at` and `status`
 * fixed to `'active'` (transitions to `'revised'`/`'withdrawn'` are the
 * appeals flow's responsibility — out of scope here, see Issue #46).
 * `task_id`/`rationale` default to `null` when omitted. Returns the
 * persisted row (all columns, as read back from the database).
 */
export function insertDecision(
  db: Database.Database,
  record: NewDecisionRecord,
): Decision {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO decisions (session_id, task_id, content, rationale, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      record.session_id,
      record.task_id ?? null,
      record.content,
      record.rationale ?? null,
      now,
    );

  const decision = findDecisionById(db, Number(result.lastInsertRowid));
  if (!decision) {
    throw new Error("failed to read back the inserted decision");
  }
  return decision;
}

/**
 * Returns all decisions ordered by `created_at` descending (`id` as a
 * tie-breaker), for the decision log screen (`GET /api/decisions`, MVP:
 * no pagination — see the ticket's explicit assumption).
 */
export function listDecisions(db: Database.Database): Decision[] {
  return db
    .prepare("SELECT * FROM decisions ORDER BY created_at DESC, id DESC")
    .all() as Decision[];
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
