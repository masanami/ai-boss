/**
 * DOM `id` of a decision-log task section (Issue #557 / S2a, 親 #438 決定15).
 *
 * Derived from the task id, not from a decision id: the sections are grouped
 * by task (`groupDecisionsByTask`), and what is addressed is "that task's
 * section", not an individual record. The section collecting records with no
 * `task_id` gets a fixed id so every section is addressable. (The task card's
 * 記録を見る no longer scrolls to it — it narrows the log instead, Issue #689.)
 */
export function decisionSectionId(taskId: number | null): string {
  return taskId === null
    ? "decision-section-unassigned"
    : `decision-section-task-${taskId}`;
}
