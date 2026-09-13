import { resolveTaskIdReferences } from "./task-id-references";
import type { Task } from "./task";

interface TaskReferenceTextProps {
  /** The boss-authored plain text to render. */
  text: string;
  /**
   * The task list to resolve `#<id>` references against, or `null` when the
   * list is unavailable (loading/error, 決定3) — every reference stays
   * undecorated in that case.
   */
  tasks: readonly Task[] | null;
}

/**
 * Renders `text` as plain text, except that a `#<id>` run resolving to a task
 * in `tasks` (決定3) is wrapped in a `<span title>` carrying that task's title
 * (決定4: ネイティブのホバーツールチップ、フォーカス可能にはしない — no
 * `tabIndex`, no `dangerouslySetInnerHTML`, no HTML string building). Never
 * changes the rendered `textContent` relative to `text` itself.
 */
function TaskReferenceText({ text, tasks }: TaskReferenceTextProps) {
  const segments = resolveTaskIdReferences(text, tasks);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "task-reference" ? (
          <span key={index} title={segment.task.title}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

export default TaskReferenceText;
