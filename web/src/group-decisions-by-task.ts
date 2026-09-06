import type { DecisionRecord } from "./decision";

/** Heading used for the section collecting decisions with no `task_id`. */
export const UNASSIGNED_SECTION_TITLE = "タスクに紐づかない決定";

export interface DecisionSection {
  /** `null` for the "no related task" section, which is always last. */
  taskId: number | null;
  /** Section heading: the task's title, or {@link UNASSIGNED_SECTION_TITLE}. */
  title: string;
  records: DecisionRecord[];
}

/**
 * Groups decision records into per-task sections for the decision log.
 *
 * Ordering (#358 判断1・判断2):
 * - within a section, records stay newest-first (`created_at` descending,
 *   `id` descending as the tie-breaker) — the same contract the API returns;
 * - sections are ordered by their own newest record, newest first;
 * - records with no `task_id` collect into a single section that is **always
 *   last**, regardless of how recent its records are. The boss's
 *   `record_decision` tool takes `task_id` as an optional field, so rulings
 *   like "tomorrow's standup moves to 9:30" legitimately have no task and
 *   must still have somewhere to live — but a box that belongs to no task
 *   should not outrank the tasks on a screen whose purpose is following them.
 *
 * Records of any `kind` (decision / mentoring) share a section and stay
 * interleaved in time, because "we reviewed the approach, so we decided this"
 * only reads as cause and effect when both sit in one chronological list
 * (#358 判断3). The kind is conveyed by a label, not by separate sections.
 *
 * Pure function: it does not mutate `records`.
 */
export function groupDecisionsByTask(
  records: DecisionRecord[],
): DecisionSection[] {
  const byTask = new Map<number, DecisionSection>();
  const unassigned: DecisionRecord[] = [];

  for (const record of sortNewestFirst(records)) {
    if (record.task_id === null) {
      unassigned.push(record);
      continue;
    }

    const existing = byTask.get(record.task_id);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    byTask.set(record.task_id, {
      taskId: record.task_id,
      // `task_title` can be null even with a task_id if the task row is gone;
      // fall back to the raw id rather than rendering an empty heading.
      title: record.task_title ?? `#${record.task_id}`,
      records: [record],
    });
  }

  // Insertion order already follows "newest record first": records were walked
  // newest-first, so each section was created when its newest record appeared.
  const sections = [...byTask.values()];

  if (unassigned.length > 0) {
    sections.push({
      taskId: null,
      title: UNASSIGNED_SECTION_TITLE,
      records: unassigned,
    });
  }

  return sections;
}

/** Newest first: `created_at` descending, `id` descending on ties. Sorts a
 * copy so the caller's array is left alone. */
function sortNewestFirst(records: DecisionRecord[]): DecisionRecord[] {
  return [...records].sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return b.id - a.id;
  });
}
