import type { Task } from "./task";
import "./TaskStartMentoringPrompt.css";

export interface TaskStartMentoringPromptProps {
  /** 促しの対象。`null` なら中身を描かない（領域自体は残す）。 */
  task: Task | null;
  /** タスクカードの「メンタリングする」と同じハンドラ（Issue #566 決定6・決定7）。 */
  onStartMentoring: (task: Task) => void;
  /** 送信中・会の切替中は非活性（タスクカードと同じ条件。AC-21）。 */
  startMentoringDisabled: boolean;
  onDismiss: () => void;
}

/**
 * タスク着手時にメンタリングを促す 1 行（Issue #566 S1）。着手はブロック
 * せず（決定1）、自動では消えない（決定4）。
 *
 * `role="status"` の領域は促しが無い間も空のまま置いておく。ライブリージョン
 * は中身ごと挿入されると支援技術が読み上げないことがあるため、既存の領域の
 * 中身を差し替えて通知させる。
 */
function TaskStartMentoringPrompt({
  task,
  onStartMentoring,
  startMentoringDisabled,
  onDismiss,
}: TaskStartMentoringPromptProps) {
  return (
    <div
      className={
        task === null
          ? "task-start-mentoring-prompt task-start-mentoring-prompt--empty"
          : "task-start-mentoring-prompt"
      }
      role="status"
      aria-label="着手時のメンタリングの促し"
    >
      {task !== null && (
        <>
          <p>
            「{task.title}」に着手しました。見積もり・進め方をボスと確認しませんか？
          </p>
          <div className="task-start-mentoring-prompt-actions">
            <button
              type="button"
              disabled={startMentoringDisabled}
              onClick={() => {
                onDismiss();
                onStartMentoring(task);
              }}
            >
              メンタリングする
            </button>
            <button type="button" onClick={onDismiss}>
              あとで
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default TaskStartMentoringPrompt;
