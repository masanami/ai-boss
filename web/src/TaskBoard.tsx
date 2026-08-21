import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import TaskCard from "./TaskCard";
import TaskForm from "./TaskForm";
import type { TaskStatus } from "./task";
import type { UseTasksResult } from "./use-tasks";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";
import "./TaskBoard.css";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "未着手" },
  { status: "in_progress", label: "進行中" },
  { status: "paused", label: "一時停止" },
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
  // ドラッグ中にハイライトすべきドロップ先カラム（Issue #122）。
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(
    null,
  );
  // ドラッグ中のタスク id（TaskCard から通知される）。ハイライトを「実際に
  // ステータスが変わるドロップ」だけに限定するために保持する。
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);

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

  // ドロップを許可するには dragover を preventDefault する必要がある
  // （しないとブラウザ既定の「ドロップ不可」動作になる）。
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  // ハイライトは handleDrop が実際に更新する組み合わせだけに出す。外部から
  // のドラッグ（draggingTaskId が null）・未知のタスク・同一カラムへのドロップ
  // は drop が何もしないため、光らせると「落とせば動く」という誤った期待を
  // 与える（レビュー指摘）。判定条件は handleDrop の早期 return と対で保つ。
  const handleDragEnter = (columnStatus: TaskStatus) => {
    if (draggingTaskId === null) {
      return;
    }
    const dragging = tasks.find((candidate) => candidate.id === draggingTaskId);
    if (dragging === undefined || dragging.status === columnStatus) {
      return;
    }
    setDragOverStatus(columnStatus);
  };

  // 子要素（カード等）への出入りでも dragleave は発火するため、本当にカラム
  // の外へ出たときだけハイライトを解除する（relatedTarget がカラム内なら無視）。
  const handleDragLeave = (
    event: DragEvent<HTMLElement>,
    columnStatus: TaskStatus,
  ) => {
    const related = event.relatedTarget as Node | null;
    if (related !== null && event.currentTarget.contains(related)) {
      return;
    }
    setDragOverStatus((current) => (current === columnStatus ? null : current));
  };

  const handleDrop = (
    event: DragEvent<HTMLElement>,
    columnStatus: TaskStatus,
  ) => {
    event.preventDefault();
    setDragOverStatus(null);
    setDraggingTaskId(null);

    const raw = event.dataTransfer.getData(TASK_DRAG_DATA_TYPE);
    const id = Number(raw);
    if (raw === "" || Number.isNaN(id)) {
      // 不正・欠損した dataTransfer は無視する（例外を投げない）。
      return;
    }

    const task = tasks.find((candidate) => candidate.id === id);
    if (task === undefined || task.status === columnStatus) {
      // 未知のタスク、または同じカラムへのドロップでは API を呼ばない。
      return;
    }

    void runAction(editTask(id, { status: columnStatus }));
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
            className={
              dragOverStatus === column.status
                ? "task-column task-column-drag-over"
                : "task-column"
            }
            aria-label={column.label}
            onDragEnter={() => handleDragEnter(column.status)}
            onDragOver={handleDragOver}
            onDragLeave={(event) => handleDragLeave(event, column.status)}
            onDrop={(event) => handleDrop(event, column.status)}
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
                      onDraggingChange={setDraggingTaskId}
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
