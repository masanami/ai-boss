import { useEffect, useState } from "react";
import TaskCard from "./TaskCard";
import TaskForm from "./TaskForm";
import type { TaskStatus } from "./task";
import type { UseTasksResult } from "./use-tasks";
import "./TaskBoard.css";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "未着手" },
  { status: "in_progress", label: "進行中" },
  { status: "done", label: "完了" },
  { status: "dropped", label: "中止" },
];

interface TaskBoardProps {
  /** AppLayout にリフトアップされた共有 tasks 状態（Issue #70）。 */
  tasksState: UseTasksResult;
}

function TaskBoard({ tasksState }: TaskBoardProps) {
  const { tasks, status, addTask, editTask, refresh } = tasksState;
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    // ボード表示（マウント）のたびに共有 tasks を再取得する。旧実装が
    // マウント時 fetch だった挙動の維持で、チャットのボス tool use による
    // タスク作成・更新をボードを開いたときに拾う。
    void refresh();
  }, [refresh]);

  // Resolves to whether the action succeeded so callers (e.g. TaskForm)
  // can keep user input when it failed.
  const runAction = (action: Promise<void>): Promise<boolean> => {
    setActionError(null);
    return action.then(
      () => true,
      (error: unknown) => {
        setActionError(
          error instanceof Error ? error.message : "操作に失敗しました",
        );
        return false;
      },
    );
  };

  return (
    <div className="task-board">
      <TaskForm onCreate={(input) => runAction(addTask(input))} />
      {status === "error" && (
        <p role="alert">タスクの取得に失敗しました</p>
      )}
      {actionError !== null && <p role="alert">{actionError}</p>}
      <div className="task-board-columns">
        {COLUMNS.map((column) => (
          <section
            key={column.status}
            className="task-column"
            aria-label={column.label}
          >
            <h2>{column.label}</h2>
            <ul>
              {tasks
                .filter((task) => task.status === column.status)
                .map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      task={task}
                      onStatusChange={(id, newStatus) =>
                        runAction(editTask(id, { status: newStatus }))
                      }
                      onEdit={(id, patch) => runAction(editTask(id, patch))}
                    />
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export default TaskBoard;
