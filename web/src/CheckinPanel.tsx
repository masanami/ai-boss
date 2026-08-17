import { useEffect, useMemo, useState } from "react";
import { selectDefaultTask } from "./select-default-task";
import { useCheckinPanel } from "./use-checkin-panel";
import type { ActivityEvent, CheckinInput } from "./activity-event";
import type { UseTasksResult } from "./use-tasks";
import "./CheckinPanel.css";

const BREAK_PRESET_MINUTES = [5, 15, 30] as const;
const DEFAULT_BREAK_MINUTES = 15;

const EVENT_TYPE_LABEL: Record<ActivityEvent["type"], string> = {
  task_start: "着手",
  break_start: "休憩開始",
  break_end: "戻り",
  checkin: "チェックイン",
  chat_message: "チャット発言",
  task_update: "タスク操作",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface CheckinPanelProps {
  /** AppLayout にリフトアップされた共有 tasksState（Issue #70）。tasks は
   * タスクボードの作成・ステータス変更がリロードなしで「着手するタスク」に
   * 反映されるのに使い、refresh はチェックイン成功時にタスクボード側の
   * ステータス変化（例: task_start による todo → in_progress、Issue #133）
   * を即時反映するために使う（Issue #134）。editTask は「完了」ボタン
   * （Issue #138）が選択中タスクを status: "done" にするために使う。
   * addTask は現状未使用だが、TaskBoard（Issue #70）と同じ「共有
   * tasksState を丸ごと受け取る」パターンに揃えている。 */
  tasksState: UseTasksResult;
}

function CheckinPanel({ tasksState }: CheckinPanelProps) {
  const { tasks, refresh, editTask } = tasksState;
  const {
    events,
    status,
    isOnBreak,
    submitError,
    isSubmitting,
    submitCheckin,
    completeTask,
  } = useCheckinPanel(refresh);

  const selectableTasks = useMemo(
    () =>
      tasks.filter(
        (task) => task.status === "todo" || task.status === "in_progress",
      ),
    [tasks],
  );
  const defaultTask = useMemo(
    () => selectDefaultTask(selectableTasks),
    [selectableTasks],
  );

  const [selectedTaskId, setSelectedTaskId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [breakPreset, setBreakPreset] = useState<string>(
    String(DEFAULT_BREAK_MINUTES),
  );
  const [customMinutes, setCustomMinutes] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    // 未選択のときはデフォルトタスクを設定する。選択中タスクが完了などで
    // selectableTasks から外れた場合も、<select> の表示と state の食い違い
    // （存在しない task_id での送信）を防ぐためデフォルトへ戻す。
    const selectionValid =
      selectedTaskId !== "" &&
      selectableTasks.some((task) => task.id === selectedTaskId);
    if (!selectionValid) {
      setSelectedTaskId(defaultTask?.id ?? "");
    }
  }, [defaultTask, selectableTasks, selectedTaskId]);

  const taskTitleById = useMemo(() => {
    const map = new Map<number, string>();
    tasks.forEach((task) => map.set(task.id, task.title));
    return map;
  }, [tasks]);

  const noteOrNull = (): string | null =>
    note.trim() === "" ? null : note.trim();

  const runSubmit = (input: CheckinInput, successMessage: string) => {
    setFeedback(null);
    void submitCheckin(input).then((ok) => {
      if (ok) {
        setNote("");
        setFeedback(successMessage);
      }
    });
  };

  const selectedTask = useMemo(
    () => selectableTasks.find((task) => task.id === selectedTaskId) ?? null,
    [selectableTasks, selectedTaskId],
  );
  const hasInProgressTask = useMemo(
    () => selectableTasks.some((task) => task.status === "in_progress"),
    [selectableTasks],
  );

  // 「ひとこと」欄は着手/休憩/戻りと異なり完了操作では送信・クリアしない
  // （決定済みの仕様: PATCH /api/tasks/:id は note を受け付けないため）。
  const handleComplete = () => {
    if (selectedTaskId === "") {
      return;
    }
    const taskId = selectedTaskId;
    setFeedback(null);
    void completeTask(taskId, editTask).then((ok) => {
      if (ok) {
        setFeedback("完了しました");
      }
    });
  };

  const handleStart = () => {
    if (selectedTaskId === "") {
      return;
    }
    runSubmit(
      { type: "task_start", task_id: selectedTaskId, note: noteOrNull() },
      "着手しました",
    );
  };

  const resolvedBreakMinutes =
    breakPreset === "custom" ? Number(customMinutes) : Number(breakPreset);
  const isBreakMinutesValid =
    Number.isInteger(resolvedBreakMinutes) && resolvedBreakMinutes > 0;

  const handleBreakStart = () => {
    if (!isBreakMinutesValid) {
      return;
    }
    runSubmit(
      {
        type: "break_start",
        expected_minutes: resolvedBreakMinutes,
        note: noteOrNull(),
      },
      "休憩を開始しました",
    );
  };

  const handleBreakEnd = () => {
    runSubmit({ type: "break_end", note: noteOrNull() }, "おかえりなさい");
  };

  return (
    <section className="checkin-panel" aria-label="チェックイン">
      <h2>チェックイン</h2>
      {isOnBreak ? (
        <div className="checkin-panel-group">
          <button
            type="button"
            className="checkin-primary-button"
            onClick={handleBreakEnd}
            disabled={isSubmitting}
          >
            戻りました
          </button>
        </div>
      ) : (
        <>
          <div className="checkin-panel-group">
            <label>
              着手するタスク
              <select
                value={selectedTaskId}
                onChange={(event) =>
                  setSelectedTaskId(
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
                disabled={selectableTasks.length === 0}
              >
                {selectableTasks.length === 0 && (
                  <option value="">タスクがありません</option>
                )}
                {selectableTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleStart}
              disabled={selectedTaskId === "" || isSubmitting}
            >
              着手
            </button>
            {hasInProgressTask && (
              <button
                type="button"
                onClick={handleComplete}
                disabled={
                  selectedTaskId === "" ||
                  selectedTask?.status !== "in_progress" ||
                  isSubmitting
                }
              >
                完了
              </button>
            )}
          </div>
          <div className="checkin-panel-group">
            <label>
              休憩時間
              <select
                value={breakPreset}
                onChange={(event) => setBreakPreset(event.target.value)}
              >
                {BREAK_PRESET_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes}分
                  </option>
                ))}
                <option value="custom">自由入力</option>
              </select>
            </label>
            {breakPreset === "custom" && (
              <input
                type="number"
                min={1}
                aria-label="休憩時間（分・自由入力）"
                value={customMinutes}
                onChange={(event) => setCustomMinutes(event.target.value)}
              />
            )}
            <button
              type="button"
              onClick={handleBreakStart}
              disabled={!isBreakMinutesValid || isSubmitting}
            >
              休憩
            </button>
          </div>
        </>
      )}
      <label>
        ひとこと（任意）
        <input
          aria-label="ひとこと"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {submitError !== null && <p role="alert">{submitError}</p>}
      {submitError === null && feedback !== null && (
        <p className="checkin-feedback">{feedback}</p>
      )}
      <h3>今日の活動</h3>
      {status === "loading" && <p>読み込み中…</p>}
      {status === "error" && <p role="alert">活動の取得に失敗しました</p>}
      {status === "ready" && (
        <ul className="checkin-activity-list">
          {events.length === 0 && <li>まだ活動はありません</li>}
          {events.map((event) => (
            <li key={event.id}>
              <span>{formatTime(event.created_at)}</span>{" "}
              <span>{EVENT_TYPE_LABEL[event.type]}</span>{" "}
              {event.task_id !== null && (
                <span>
                  {taskTitleById.get(event.task_id) ?? `タスク#${event.task_id}`}
                </span>
              )}
              {event.note !== null && event.note !== "" && (
                <span>{event.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default CheckinPanel;
