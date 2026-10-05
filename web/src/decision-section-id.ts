/**
 * DOM `id` of a decision-log task section (Issue #557 / S2a, 親 #438 決定15).
 *
 * Derived from the task id, not from a decision id: the sections are grouped
 * by task (`groupDecisionsByTask`), and what is addressed is "that task's
 * section", not an individual record. The section collecting records with no
 * `task_id` gets a fixed id so every section is addressable.
 *
 * Issue #689: nothing in the app addresses these ids any more — the task
 * card's 記録を見る now narrows the log instead of scrolling to the section.
 * They are kept as stable section identities (the DecisionLog tests pin them)
 * rather than removed in a fix that should not change the log's markup.
 */
export function decisionSectionId(taskId: number | null): string {
  return taskId === null
    ? "decision-section-unassigned"
    : `decision-section-task-${taskId}`;
}
