import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import TaskCard from "./TaskCard";
import TaskForm from "./TaskForm";
import type { TaskStatus } from "./task";
import type { UseTasksResult } from "./use-tasks";
import { TASK_DRAG_DATA_TYPE } from "./task-dnd";
import { describeTasksApiError } from "./tasks-api";
import {
  isWithinRecentLocalDays,
  terminalReferenceAt,
} from "./recent-terminal-tasks";
import "./TaskBoard.css";

/**
 * 「完了」「中止」列に残す期間（当日を含むローカル暦日の日数。Issue #428）。
 * 終端ステータスの 2 列だけはタスクが出ていかないため、絞らないと使用期間に
 * 比例して伸び続ける。設定 UI は作らずコード内定数で固定する（決定 2。前例:
 * `CheckinPanel.tsx` の `DEFAULT_BREAK_MINUTES`）。
 */
const RECENT_TERMINAL_WINDOW_DAYS = 7;

interface BoardColumn {
  status: TaskStatus;
  /**
   * 列の `aria-label`。見出しの表示ラベルとは分離してあり、絞り込みの表示
   * （決定 6）を入れても**変えない**（支援技術・既存テストの参照先）。
   */
  label: string;
  /** 直近 `RECENT_TERMINAL_WINDOW_DAYS` 日に絞る列か（done / dropped）。 */
  limitedToRecentWindow?: boolean;
}

const COLUMNS: BoardColumn[] = [
  { status: "todo", label: "未着手" },
  { status: "in_progress", label: "進行中" },
  { status: "paused", label: "一時停止" },
  { status: "done", label: "完了", limitedToRecentWindow: true },
  { status: "dropped", label: "中止", limitedToRecentWindow: true },
];

/**
 * 見出しの文言。絞り込み中の列はその範囲を示す（決定 6: 何も示さないと
 * 「昨日完了したはずのカードが無い」理由が UI のどこにも無い）。日数は
 * 定数から導出し、テンプレートに直書きして二重管理にしない。
 */
function columnHeading(column: BoardColumn): string {
  return column.limitedToRecentWindow === true
    ? `${column.label}（直近 ${RECENT_TERMINAL_WINDOW_DAYS} 日）`
    : column.label;
}

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
        // 決定 2-g・AC-76: 表示分岐はエラー文言ではなく code の値で行う
        // （evidence_required のときは固定文言、それ以外はサーバのメッセージ）。
        setActionError(describeTasksApiError(error, "操作に失敗しました"));
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

  // 「今」はレンダリングのたびに 1 回取得する（明示的な仮定 5・前例:
  // TodaySummary.tsx。clock prop や時計監視タイマーは新設しない）。
  const now = new Date();

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
            <h2>{columnHeading(column)}</h2>
            <ul>
              {tasks
                .filter(
                  (task) =>
                    task.status === column.status &&
                    (column.limitedToRecentWindow !== true ||
                      isWithinRecentLocalDays(
                        terminalReferenceAt(task),
                        now,
                        RECENT_TERMINAL_WINDOW_DAYS,
                      )),
                )
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
