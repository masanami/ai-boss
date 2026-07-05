import { useState } from "react";
import type { FormEvent } from "react";
import { TASK_STATUSES } from "./task";
import type { Task, TaskPatchInput, TaskPriority, TaskStatus } from "./task";

interface TaskCardProps {
  task: Task;
  onStatusChange: (id: number, status: TaskStatus) => void;
  onEdit: (id: number, patch: TaskPatchInput) => void;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  done: "完了",
  dropped: "中止",
};

// due_at は yyyy-MM-dd を想定するが、ISO 日時（ボスの tool use 等の将来経路）
// が入っても date input が黙って空欄→null 保存しないよう日付部分に正規化する
function toDateInputValue(dueAt: string | null): string {
  return (dueAt ?? "").slice(0, 10);
}

function TaskCard({ task, onStatusChange, onEdit }: TaskCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority | "">(
    task.priority ?? "",
  );
  const [dueAt, setDueAt] = useState(toDateInputValue(task.due_at));

  const startEditing = () => {
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority(task.priority ?? "");
    setDueAt(toDateInputValue(task.due_at));
    setIsEditing(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "") {
      return;
    }
    onEdit(task.id, {
      title: title.trim(),
      description: description.trim() === "" ? null : description.trim(),
      priority: priority === "" ? null : priority,
      due_at: dueAt === "" ? null : dueAt,
    });
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <form
        className="task-card task-card-edit"
        aria-label="タスクを編集"
        onSubmit={handleSubmit}
      >
        <label>
          タイトル
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          説明
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          優先度
          <select
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority | "")
            }
          >
            <option value="">未設定</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          締切
          <input
            type="date"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
        </label>
        <div className="task-card-actions">
          <button type="submit">保存</button>
          <button type="button" onClick={() => setIsEditing(false)}>
            キャンセル
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="task-card">
      <h3>{task.title}</h3>
      {task.description !== null && task.description !== "" && (
        <p>{task.description}</p>
      )}
      {task.priority !== null && (
        <p>ボス決定: 優先度 {PRIORITY_LABEL[task.priority]}</p>
      )}
      {task.due_at !== null && (
        <p>ボス決定: 締切 {toDateInputValue(task.due_at)}</p>
      )}
      {task.boss_comment !== null && <p>ボスコメント: {task.boss_comment}</p>}
      <label>
        ステータス
        <select
          value={task.status}
          onChange={(event) =>
            onStatusChange(task.id, event.target.value as TaskStatus)
          }
        >
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>
      <div className="task-card-actions">
        <button type="button" onClick={startEditing}>
          編集
        </button>
      </div>
    </div>
  );
}

export default TaskCard;
