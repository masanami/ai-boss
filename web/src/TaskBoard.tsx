import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import TaskCard from "./TaskCard";
import TaskForm from "./TaskForm";
import type { Task, TaskStatus } from "./task";
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
  /**
   * 直近 `RECENT_TERMINAL_WINDOW_DAYS` 日に絞る列か（done / dropped）。
   * 既定で畳む列（開閉トグルを出す列）の判定にも兼用する（Issue #515。
   * 仕様では窓で絞る 2 列がそのまま畳む対象なので、別フラグを増やさない）。
   */
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
 * 見出しの文言。絞り込み中の列はその範囲と窓内の件数を示す（決定 6: 何も
 * 示さないと「昨日完了したはずのカードが無い」理由が UI のどこにも無い。
 * Issue #515 決定2で件数表示を追加: 畳んだまま「空かどうか」が分からない
 * と、確かめるために毎回開くことになるため）。日数・件数は定数と実際の
 * 描画件数（`visibleCount`）から導出し、テンプレートに直書きして二重管理
 * にしない。文言は開閉で変えない（押すたびに帯の幅や行の高さが揺れない
 * ようにするため）。
 */
function columnHeading(column: BoardColumn, visibleCount: number): string {
  return column.limitedToRecentWindow === true
    ? `${column.label}（直近 ${RECENT_TERMINAL_WINDOW_DAYS} 日・${visibleCount} 件）`
    : column.label;
}

interface TaskBoardProps {
  /** AppLayout にリフトアップされた共有 tasks 状態（Issue #70）。 */
  tasksState: UseTasksResult;
  /**
   * タスクカードからのメンタリング起動（Issue #470, 親 #444 決定1）。
   * `TaskCard` へそのまま渡すだけで、判断には関与しない（adhoc 区間かどうか
   * の判定は `AppLayout` が持つ）。引数はクリックされたカードのタスクその
   * ものである（Issue #489 / S1a 決定9）。
   */
  onStartMentoring?: ((task: Task) => void) | null;
  /**
   * メンタリング導線の非活性（Issue #489 / S1a 決定8）。これも `TaskCard`
   * へそのまま渡すだけで、可否の判断（送信中・切替中かどうか）は
   * `AppLayout` が持つ。
   */
  startMentoringDisabled?: boolean;
  /**
   * タスクの記録を決定ログで読み返す導線（Issue #557 / S2a）。これも
   * `TaskCard` へそのまま渡すだけで、判断には関与しない。
   */
  onShowTaskRecords?: ((task: Task) => void) | null;
}

function TaskBoard({
  tasksState,
  onStartMentoring,
  startMentoringDisabled,
  onShowTaskRecords,
}: TaskBoardProps) {
  const { tasks, status, addTask, editTask, refresh } = tasksState;
  const [actionError, setActionError] = useState<string | null>(null);
  // ドラッグ中にハイライトすべきドロップ先カラム（Issue #122）。
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(
    null,
  );
  // ドラッグ中のタスク id（TaskCard から通知される）。ハイライトを「実際に
  // ステータスが変わるドロップ」だけに限定するために保持する。
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);
  // 展開中の終端列（完了・中止）。既定は畳み（Issue #515 決定3）。保存しない
  // ため、アンマウント（タブ切替）のたびに state ごと消え既定へ戻る。
  const [expandedTerminalColumns, setExpandedTerminalColumns] = useState<
    ReadonlySet<TaskStatus>
  >(() => new Set());

  const toggleColumnExpanded = (status: TaskStatus) => {
    setExpandedTerminalColumns((current) => {
      const next = new Set(current);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

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
        {COLUMNS.map((column) => {
          // 畳める列＝窓で絞る列。畳めない列（未着手/進行中/一時停止）は
          // 常に展開扱いにし、開閉トグルを出さない。
          const isCollapsible = column.limitedToRecentWindow === true;
          const isExpanded =
            !isCollapsible || expandedTerminalColumns.has(column.status);
          // 列に描画する対象（窓の絞り込み込み）を 1 回だけ計算し、見出しの
          // 件数とカード描画の両方に使う（別の数え方を作らない）。
          const visibleTasks = tasks.filter(
            (task) =>
              task.status === column.status &&
              (column.limitedToRecentWindow !== true ||
                isWithinRecentLocalDays(
                  terminalReferenceAt(task),
                  now,
                  RECENT_TERMINAL_WINDOW_DAYS,
                )),
          );
          // 開閉状態を CSS へ渡す（畳んだ列は内容の幅に詰めた帯にする）。
          const columnClassNames = ["task-column"];
          if (!isExpanded) {
            columnClassNames.push("task-column-collapsed");
          }
          if (dragOverStatus === column.status) {
            columnClassNames.push("task-column-drag-over");
          }

          return (
            <section
              key={column.status}
              className={columnClassNames.join(" ")}
              aria-label={column.label}
              onDragEnter={() => handleDragEnter(column.status)}
              onDragOver={handleDragOver}
              onDragLeave={(event) => handleDragLeave(event, column.status)}
              onDrop={(event) => handleDrop(event, column.status)}
            >
              <h2>
                {isCollapsible ? (
                  <button
                    type="button"
                    className="task-column-toggle"
                    aria-expanded={isExpanded}
                    onClick={() => toggleColumnExpanded(column.status)}
                  >
                    {columnHeading(column, visibleTasks.length)}
                  </button>
                ) : (
                  columnHeading(column, visibleTasks.length)
                )}
              </h2>
              {isExpanded && (
                <ul>
                  {visibleTasks.map((task) => (
                    <li key={task.id}>
                      <TaskCard
                        task={task}
                        onStatusChange={(id, newStatus) =>
                          runAction(editTask(id, { status: newStatus }))
                        }
                        onEdit={(id, patch) => runAction(editTask(id, patch))}
                        onDraggingChange={setDraggingTaskId}
                        onStartMentoring={onStartMentoring}
                        startMentoringDisabled={startMentoringDisabled}
                        onShowTaskRecords={onShowTaskRecords}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default TaskBoard;
