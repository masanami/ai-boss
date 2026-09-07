import type Database from "better-sqlite3";
import type { RecentDecision } from "../boss/persona-prompt.js";
import type { Decision, DecisionKind, DecisionListItem } from "./decision.js";

interface DecisionRow {
  content: string;
  created_at: string;
}

export interface NewDecisionRecord {
  session_id: number;
  task_id?: number | null;
  content: string;
  rationale?: string | null;
  /** #276: 'mentoring' 行はこの引数を明示して書く。省略時は列の
   * DEFAULT 'decision' に委ね、既存呼び出し（`record_decision`）の
   * 挙動は変えない。 */
  kind?: DecisionKind;
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
 * fixed to `'active'`. `task_id`/`rationale` default to `null` when omitted.
 * `kind` defaults to `'decision'` when omitted, matching the column's
 * `DEFAULT 'decision'` (see Issue #358/#397); `record_mentoring` (#276)
 * passes `kind: 'mentoring'` explicitly. Returns the persisted row (all
 * columns, as read back from the database).
 */
export function insertDecision(
  db: Database.Database,
  record: NewDecisionRecord,
): Decision {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO decisions (session_id, task_id, content, rationale, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      record.session_id,
      record.task_id ?? null,
      record.content,
      record.rationale ?? null,
      record.kind ?? "decision",
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
 *
 * Each row carries the related task's title as `task_title` (`null` when
 * `task_id` is `null`, or when the referenced task no longer exists), so the
 * screen can head each task section with a name instead of a raw id. The
 * join lives here rather than in the client because `DecisionLog` holds no
 * task list, and wiring one in would make the decision log's rendering
 * depend on whether the task fetch succeeded (#358 判断5).
 *
 * Rows are returned flat, in `created_at` order — grouping into task
 * sections is the renderer's job (#358 判断5・ADR 0006 決定1).
 */
export function listDecisions(db: Database.Database): DecisionListItem[] {
  return db
    .prepare(
      `SELECT decisions.*, tasks.title AS task_title
       FROM decisions
       LEFT JOIN tasks ON tasks.id = decisions.task_id
       ORDER BY decisions.created_at DESC, decisions.id DESC`,
    )
    .all() as DecisionListItem[];
}

/**
 * Returns the most recent `limit` decisions (created_at descending), mapped
 * to the shape `buildPersonaPrompt` expects (`decidedAt`).
 *
 * Read-only helper for chat context building (#27). Writing decisions
 * (recording a boss decision) is out of scope here — see Issue #6.
 *
 * Excludes `kind = 'mentoring'` rows at the SQL level (#408 AC-42): a JS-side
 * filter after the `LIMIT` would let mentoring rows eat into the limited
 * window and shrink the number of actual decisions returned.
 */
export function listRecentDecisions(
  db: Database.Database,
  limit: number,
): RecentDecision[] {
  const rows = db
    .prepare(
      "SELECT content, created_at FROM decisions WHERE kind = 'decision' ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as DecisionRow[];

  return rows.map((row) => ({
    content: row.content,
    decidedAt: row.created_at,
  }));
}
