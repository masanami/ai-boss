import { useState } from "react";
import { partitionTodayTasks, selectTodayTasks } from "./today-tasks";
import type { Task } from "./task";
import type { TasksLoadStatus } from "./use-tasks";
import "./TodaySummary.css";

interface TodaySummaryProps {
  tasks: Task[];
  status: TasksLoadStatus;
}

/**
 * サイドパネルの「今日のタスク」「進捗」セクション
 * （当日分のみを集計し、完了と未完了をマーカーで区別する）。
 * 対象タスクと進捗はサーバーのノルマ進捗と同じ定義で導出する。
 * 完了タスクは既定で折りたたんだ末尾セクションへ寄せる（#245・#427）。
 * 展開状態は永続化しない（マウントごとに折りたたみへ戻る）。
 */
function TodaySummary({ tasks, status }: TodaySummaryProps) {
  const [doneExpanded, setDoneExpanded] = useState(false);
  const todayTasks = selectTodayTasks(tasks, new Date());
  const done = todayTasks.filter((task) => task.status === "done").length;
  const total = todayTasks.length;
  const percentage = total === 0 ? 0 : Math.round((done / total) * 100);
  const { pending: pendingTasks, done: completedTasks } =
    partitionTodayTasks(todayTasks);

  return (
    <>
      <section aria-label="今日のタスク">
        <h2>今日のタスク</h2>
        {status === "loading" && <p>読み込み中…</p>}
        {status === "error" && (
          <p role="alert">タスクの取得に失敗しました</p>
        )}
        {status === "ready" && todayTasks.length === 0 && (
          <p>今日のタスクはまだありません</p>
        )}
        {status === "ready" &&
          todayTasks.length > 0 &&
          pendingTasks.length === 0 && (
            <p>今日のタスクはすべて完了しました</p>
          )}
        {status === "ready" && pendingTasks.length > 0 && (
          <ul className="today-summary-list">
            {pendingTasks.map((task) => (
              <li key={task.id}>□ {task.title}</li>
            ))}
          </ul>
        )}
        {status === "ready" && completedTasks.length > 0 && (
          <div className="today-summary-done-toggle">
            <button
              type="button"
              aria-expanded={doneExpanded}
              onClick={() => setDoneExpanded((expanded) => !expanded)}
            >
              完了したタスク（{completedTasks.length} 件）
            </button>
            {doneExpanded && (
              <ul className="today-summary-list">
                {completedTasks.map((task) => (
                  <li key={task.id}>■ {task.title}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      <section aria-label="進捗">
        <h2>進捗</h2>
        <div
          className="today-summary-progress-bar"
          role="progressbar"
          aria-label="今日のノルマ進捗"
          aria-valuenow={percentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="today-summary-progress-bar-fill"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="today-summary-progress-text">
          {done} / {total} 件完了（{percentage}%）
        </p>
      </section>
    </>
  );
}

export default TodaySummary;
