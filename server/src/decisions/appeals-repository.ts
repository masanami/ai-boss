import type Database from "better-sqlite3";
import type { Appeal, AppealVerdict } from "./appeal.js";

export interface NewAppealRecord {
  decision_id: number;
  content: string;
  verdict: AppealVerdict;
  response: string;
}

export function findAppealById(
  db: Database.Database,
  id: number,
): Appeal | undefined {
  return db.prepare("SELECT * FROM appeals WHERE id = ?").get(id) as
    | Appeal
    | undefined;
}

/**
 * Inserts a new appeal (a user's objection to a decision, plus the boss's
 * verdict/response) with a server-managed `created_at`. Returns the
 * persisted row (all columns, as read back from the database).
 */
export function insertAppeal(
  db: Database.Database,
  record: NewAppealRecord,
): Appeal {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO appeals (decision_id, content, verdict, response, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(record.decision_id, record.content, record.verdict, record.response, now);

  const appeal = findAppealById(db, Number(result.lastInsertRowid));
  if (!appeal) {
    throw new Error("failed to read back the inserted appeal");
  }
  return appeal;
}

/**
 * Returns all appeals for the given decision, ordered by created_at
 * ascending (oldest first), for the decision log's appeal history display.
 */
export function listAppealsByDecisionId(
  db: Database.Database,
  decisionId: number,
): Appeal[] {
  return db
    .prepare("SELECT * FROM appeals WHERE decision_id = ? ORDER BY created_at ASC, id ASC")
    .all(decisionId) as Appeal[];
}

/**
 * Returns all appeals grouped by `decision_id`, for attaching each
 * decision's appeal history to `GET /api/decisions` without an N+1 query.
 */
export function listAppealsGroupedByDecisionId(
  db: Database.Database,
): Map<number, Appeal[]> {
  const rows = db
    .prepare("SELECT * FROM appeals ORDER BY created_at ASC, id ASC")
    .all() as Appeal[];

  const grouped = new Map<number, Appeal[]>();
  for (const row of rows) {
    const existing = grouped.get(row.decision_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.decision_id, [row]);
    }
  }
  return grouped;
}
